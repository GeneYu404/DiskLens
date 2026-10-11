//! NTFS `$MFT` 直读（WizTree 的做法）。
//!
//! NTFS 把卷上所有文件的元数据都放在 `$MFT` 里。顺序读取它，就不需要逐个打开目录，
//! 百万文件通常 1~3 秒即可完成：
//!
//!  1. 以管理员身份打开 `\\.\C:`；
//!  2. 读引导扇区，得到簇大小、`$MFT` 起始簇、记录大小；
//!  3. 读第 0 条记录（`$MFT` 自身），解析其 `$DATA` 的 data runs，得到 MFT 的所有片段；
//!  4. 按 4MB 大块顺序读取片段，每块内的 FILE 记录并行解析：
//!     - `$STANDARD_INFORMATION (0x10)`：修改时间
//!     - `$FILE_NAME (0x30)`：文件名 + 父目录记录号（优先 Win32 命名空间，跳过 8.3 短名）
//!     - `$DATA (0x80)`：未命名数据流的大小（常驻 / 非常驻）
//!  5. 按父记录号做计数排序建立子节点表，从根目录（记录 #5）BFS 建树；
//!  6. FlatTree.Finalize 自底向上汇总大小。
//!
//! 解析逻辑与平台无关，ScanReader 可以直接读取 NTFS 磁盘镜像文件做测试；
//! 只有 ScanVolume（打开物理卷）是 Windows 专用。
//!
//! 已处理：更新序列（fixup）、碎片化的 `$MFT`、扩展记录（`$ATTRIBUTE_LIST` 指向的
//! 记录中的 `$DATA`）、硬链接（每个文件只挂在一个父目录下，只统计一次）、稀疏运行。
//! 未处理：命名数据流（ADS）、簇小于记录大小的卷（会报错并由上层回退到遍历模式）。

package core

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"
)

const (
	rootRecord = 5
	refMask    = uint64(0x0000FFFFFFFFFFFF)
)

const (
	attrStandardInformation uint32 = 0x10
	attrFileName            uint32 = 0x30
	attrData                uint32 = 0x80
	attrEnd                 uint32 = 0xFFFFFFFF
)

const (
	recordInUse uint16 = 0x0001
	recordIsDir uint16 = 0x0002
)

// align 是引导扇区 / 第 0 条记录读取时的对齐单位（兼容 4Kn 硬盘）。
const align = 4096

// readChunk 是顺序读取块大小。
const readChunk = 4 << 20

type geometry struct {
	clusterSize uint64
	mftOffset   uint64
	recordSize  int
}

type run struct {
	// lcnValid 为 false 表示稀疏运行（没有分配磁盘空间）。
	lcnValid bool
	lcn      uint64
	clusters uint64
}

// parsed 是单条记录的解析结果（并行阶段产出，串行阶段合并）。
type parsed struct {
	// target：属性归属的记录 —— 基本记录为自身，扩展记录为其基本记录。
	target   uint64
	isBase   bool
	isDir    bool
	hasName  bool
	namePos  uint8
	namePar  uint64
	name     string
	hasSize  bool
	size     uint64
	hasMod   bool
	modified uint32
}

// entry 是按记录号索引的汇总信息。
type entry struct {
	parent   uint64
	name     string
	hasName  bool
	nameRank uint8
	size     uint64
	modified uint32
	inUse    bool
	isDir    bool
}

// DriveRootLetter 判断 path 是不是卷根目录（C:\、C:），是则返回盘符。
func DriveRootLetter(path string) (byte, bool) {
	trimmed := path
	for len(trimmed) > 0 && (trimmed[len(trimmed)-1] == '\\' || trimmed[len(trimmed)-1] == '/') {
		trimmed = trimmed[:len(trimmed)-1]
	}
	if len(trimmed) != 2 || trimmed[1] != ':' {
		return 0, false
	}
	c := trimmed[0]
	if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
		return 0, false
	}
	return c, true
}

// ScanReader 从任意 NTFS 数据源（物理卷或磁盘镜像）读取 $MFT 并建树。
func ScanReader(dev io.ReaderAt, rootPath string, progress *ScanProgress) (*FlatTree, error) {
	// 1. 引导扇区
	boot := make([]byte, align)
	if _, err := dev.ReadAt(boot, 0); err != nil {
		return nil, fmt.Errorf("读取引导扇区失败: %w", err)
	}
	geo, err := parseBoot(boot)
	if err != nil {
		return nil, err
	}
	if geo.clusterSize < uint64(geo.recordSize) {
		return nil, errors.New("簇小于 MFT 记录大小的卷暂不支持")
	}

	// 2. 第 0 条记录：$MFT 自身，从中得到 MFT 的全部片段
	first := make([]byte, alignUp(geo.recordSize, align))
	if _, err := dev.ReadAt(first, int64(geo.mftOffset)); err != nil {
		return nil, fmt.Errorf("读取 $MFT 第 0 条记录失败: %w", err)
	}
	record0 := first[:geo.recordSize]
	if !applyFixup(record0) || string(record0[0:4]) != "FILE" {
		return nil, errors.New("$MFT 第 0 条记录损坏")
	}
	mftBytes, runs, ok := mftLayout(record0)
	if !ok {
		return nil, errors.New("无法定位 $MFT 的数据区")
	}

	total := mftBytes / uint64(geo.recordSize)
	progress.RecordsTotal.Store(total)
	entries := make([]entry, total)

	// 3. 大块顺序读取 + 块内并行解析
	chunkCap := readChunk - readChunk%int(geo.clusterSize)
	if chunkCap < int(geo.clusterSize) {
		chunkCap = int(geo.clusterSize)
	}
	buf := make([]byte, chunkCap)
	var recordNo uint64

	for _, r := range runs {
		if recordNo >= total {
			break
		}
		runBytes := r.clusters * geo.clusterSize
		if !r.lcnValid {
			recordNo += runBytes / uint64(geo.recordSize)
			continue
		}
		if progress.IsCancelled() {
			return nil, ErrCancelled
		}

		var done uint64
		for done < runBytes && recordNo < total {
			if progress.IsCancelled() {
				return nil, ErrCancelled
			}
			want := runBytes - done
			if want > uint64(chunkCap) {
				want = uint64(chunkCap)
			}
			chunk := buf[:want]
			if _, err := dev.ReadAt(chunk, int64(r.lcn*geo.clusterSize+done)); err != nil && err != io.EOF {
				return nil, fmt.Errorf("读取 $MFT 数据失败: %w", err)
			}

			firstNo := recordNo
			parsed := parseChunk(chunk, geo.recordSize, firstNo, total)
			for _, item := range parsed {
				merge(entries, item)
			}

			recordNo += uint64(int(want) / geo.recordSize)
			done += want
			v := min(recordNo, total)
			progress.RecordsDone.Store(v)
		}
	}

	// 4. 建树
	return buildTree(entries, rootPath, progress)
}

// parseChunk 把一块数据按记录切分并行解析。
func parseChunk(chunk []byte, recordSize int, firstNo, total uint64) []parsed {
	n := len(chunk) / recordSize
	if n == 0 {
		return nil
	}
	results := make([][]parsed, n)
	var wg sync.WaitGroup
	// 记录解析是纯 CPU 的，按逻辑核数分批并行
	workers := runtimeNumCPU()
	if workers > n {
		workers = n
	}
	chunkPer := divCeil(n, workers)
	for s := 0; s < n; s += chunkPer {
		e := s + chunkPer
		if e > n {
			e = n
		}
		wg.Add(1)
		go func(from, to int) {
			defer wg.Done()
			out := make([]parsed, 0, to-from)
			for i := from; i < to; i++ {
				no := firstNo + uint64(i)
				if no >= total {
					continue
				}
				// 每条记录单独一份副本：applyFixup 会就地改写，不能让并行线程抢同一块内存
				rec := make([]byte, recordSize)
				copy(rec, chunk[i*recordSize:(i+1)*recordSize])
				if !applyFixup(rec) {
					continue
				}
				if item, ok := parseRecord(rec, no); ok {
					out = append(out, item)
				}
			}
			results[from] = out
		}(s, e)
	}
	wg.Wait()

	out := make([]parsed, 0, n)
	for _, r := range results {
		out = append(out, r...)
	}
	return out
}

func parseBoot(boot []byte) (geometry, error) {
	if len(boot) < 512 || string(boot[3:11]) != "NTFS    " {
		return geometry{}, errors.New("不是 NTFS 卷")
	}
	bytesPerSector := uint64(rdU16(boot, 0x0B))
	rawSpc := boot[0x0D]
	// 大簇（≥ 64KB）时该字段是负指数：2^(256 - x)
	var sectorsPerCluster uint64
	if rawSpc <= 0x80 {
		sectorsPerCluster = uint64(rawSpc)
	} else {
		sectorsPerCluster = uint64(1) << (256 - uint32(rawSpc))
	}
	clusterSize := bytesPerSector * sectorsPerCluster
	mftLcn := rdU64(boot, 0x30)
	clustersPerRecord := int8(boot[0x40])
	var recordSize uint64
	if clustersPerRecord > 0 {
		recordSize = uint64(clustersPerRecord) * clusterSize
	} else {
		recordSize = uint64(1) << uint(-int(clustersPerRecord))
	}

	if bytesPerSector < 256 || bytesPerSector > 4096 || clusterSize == 0 ||
		recordSize < 256 || recordSize > 65536 {
		return geometry{}, errors.New("NTFS 引导扇区参数异常")
	}
	return geometry{
		clusterSize: clusterSize,
		mftOffset:   mftLcn * clusterSize,
		recordSize:  int(recordSize),
	}, nil
}

// applyFixup 应用更新序列（fixup）：每 512 字节末尾两字节被替换成了校验值，需要还原。
// 校验失败（写入被撕裂）时返回 false。
func applyFixup(record []byte) bool {
	if len(record) < 48 || string(record[0:4]) != "FILE" {
		return false
	}
	usaOffset := int(rdU16(record, 4))
	usaCount := int(rdU16(record, 6))
	if usaCount < 2 || usaOffset+usaCount*2 > len(record) {
		return false
	}
	check0, check1 := record[usaOffset], record[usaOffset+1]
	for i := 1; i < usaCount; i++ {
		pos := i*512 - 2
		if pos+2 > len(record) {
			break
		}
		if record[pos] != check0 || record[pos+1] != check1 {
			return false
		}
		record[pos] = record[usaOffset+i*2]
		record[pos+1] = record[usaOffset+i*2+1]
	}
	return true
}

// mftLayout 从 $MFT 自身的记录中取出 MFT 总字节数与 data runs。
func mftLayout(record []byte) (uint64, []run, bool) {
	var total uint64
	var runs []run
	found := false
	forEachAttribute(record, func(kind uint32, attr []byte) bool {
		if kind != attrData || attr[8] == 0 || attr[9] != 0 {
			return true // 只认「非常驻且无名字」的 $DATA
		}
		runsOffset := int(rdU16(attr, 32))
		if runsOffset >= len(attr) {
			return false
		}
		total = rdU64(attr, 48)
		runs = parseRuns(attr[runsOffset:])
		found = true
		return false
	})
	return total, runs, found
}

// parseRuns 解码 data runs：每项头字节低 4 位是长度字段字节数，高 4 位是偏移字段字节数；
// 偏移是相对上一项 LCN 的有符号数，偏移字节数为 0 表示稀疏。
func parseRuns(b []byte) []run {
	var runs []run
	pos := 0
	var lcn int64
	for pos < len(b) {
		header := b[pos]
		if header == 0 {
			break
		}
		lenSize := int(header & 0x0F)
		offSize := int(header >> 4)
		pos++
		if lenSize == 0 || lenSize > 8 || offSize > 8 || pos+lenSize+offSize > len(b) {
			break
		}

		var clusters uint64
		for i := 0; i < lenSize; i++ {
			clusters |= uint64(b[pos+i]) << (8 * i)
		}
		pos += lenSize

		if offSize == 0 {
			runs = append(runs, run{lcnValid: false, clusters: clusters})
			continue
		}
		var delta int64
		for i := 0; i < offSize; i++ {
			delta |= int64(b[pos+i]) << (8 * i)
		}
		shift := uint(64 - 8*offSize)
		// 符号扩展
		delta = (delta << shift) >> shift
		pos += offSize

		lcn += delta
		runs = append(runs, run{lcnValid: lcn >= 0, lcn: uint64(lcn), clusters: clusters})
	}
	return runs
}

func parseRecord(record []byte, recordNo uint64) (parsed, bool) {
	flags := rdU16(record, 22)
	if flags&recordInUse == 0 {
		return parsed{}, false
	}
	base := rdU64(record, 32) & refMask
	out := parsed{
		target: recordNo,
		isBase: base == 0,
		isDir:  flags&recordIsDir != 0,
	}
	if base != 0 {
		out.target = base
	}

	forEachAttribute(record, func(kind uint32, attr []byte) bool {
		nonResident := attr[8] != 0
		nameLen := attr[9]
		switch {
		case kind == attrStandardInformation && !nonResident:
			value := residentValue(attr)
			if len(value) >= 16 {
				out.modified = fileTimeToUnix(rdU64(value, 8))
				out.hasMod = true
			}
		case kind == attrFileName && !nonResident:
			value := residentValue(attr)
			if len(value) < 66 {
				return true
			}
			chars := int(value[64])
			rank := namespaceRank(value[65])
			better := !out.hasName || rank > out.namePos
			if better && 66+chars*2 <= len(value) {
				units := make([]uint16, chars)
				for i := 0; i < chars; i++ {
					units[i] = binary.LittleEndian.Uint16(value[66+i*2:])
				}
				out.name = utf16UnitsToString(units)
				out.namePar = rdU64(value, 0) & refMask
				out.namePos = rank
				out.hasName = true
			}
		case kind == attrData && nameLen == 0:
			if nonResident {
				// 只有 lowest_vcn == 0 的片段携带真实大小
				if rdU64(attr, 16) == 0 {
					out.size = rdU64(attr, 48)
					out.hasSize = true
				}
			} else {
				out.size = uint64(rdU32(attr, 16))
				out.hasSize = true
			}
		}
		return true
	})
	return out, true
}

func merge(entries []entry, item parsed) {
	if int(item.target) >= len(entries) {
		return
	}
	e := &entries[item.target]
	if item.isBase {
		e.inUse = true
		e.isDir = item.isDir
	}
	if item.hasName && (!e.hasName || item.namePos > e.nameRank) {
		e.name = item.name
		e.hasName = true
		e.parent = item.namePar
		e.nameRank = item.namePos
	}
	if item.hasSize {
		e.size = item.size
	}
	if item.hasMod {
		e.modified = item.modified
	}
}

func buildTree(entries []entry, rootPath string, progress *ScanProgress) (*FlatTree, error) {
	n := len(entries)
	if n <= rootRecord || !entries[rootRecord].inUse {
		return nil, errors.New("根目录记录 (#5) 无效")
	}

	// 有效的「子 → 父」关系：父记录存在、在用、是目录；根目录自身排除（它的父是自己）
	parentOf := func(r int) int {
		e := &entries[r]
		if r == rootRecord || !e.inUse || !e.hasName {
			return -1
		}
		p := int(e.parent)
		if p < n && p != r && entries[p].inUse && entries[p].isDir {
			return p
		}
		return -1
	}

	// 计数排序建立子节点表（CSR）
	start := make([]uint32, n+1)
	for r := 0; r < n; r++ {
		if p := parentOf(r); p >= 0 {
			start[p+1]++
		}
	}
	for i := 0; i < n; i++ {
		start[i+1] += start[i]
	}
	fill := make([]uint32, n+1)
	copy(fill, start)
	kids := make([]uint32, start[n])
	for r := 0; r < n; r++ {
		if p := parentOf(r); p >= 0 {
			kids[fill[p]] = uint32(r)
			fill[p]++
		}
	}

	// 从根目录 BFS：每条记录只有一个父节点，所以最多访问一次，不会因损坏数据死循环
	linked := int(start[n])
	tree := NewFlatTree(linked+1, linked*20)
	tree.SetRootPath(rootPath)
	rootID := tree.Push(None, rootPath, 0, entries[rootRecord].modified, FlagDir)

	var files, dirs, bytes uint64 = 0, 1, 0
	type qitem struct {
		record int
		id     uint32
	}
	queue := []qitem{{rootRecord, rootID}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, child := range kids[start[cur.record]:start[cur.record+1]] {
			e := &entries[child]
			name := e.name
			if !e.hasName {
				name = "?"
			}
			if e.isDir {
				childID := tree.Push(cur.id, name, 0, e.modified, FlagDir)
				queue = append(queue, qitem{int(child), childID})
				dirs++
			} else {
				tree.Push(cur.id, name, e.size, e.modified, 0)
				files++
				bytes += e.size
			}
		}
	}

	progress.Files.Store(files)
	progress.Dirs.Store(dirs)
	progress.Bytes.Store(bytes)
	tree.Finalize()
	return tree, nil
}

// forEachAttribute 遍历一条 FILE 记录中的属性。回调返回 false 可提前中止。
func forEachAttribute(record []byte, fn func(kind uint32, attr []byte) bool) {
	offset := int(rdU16(record, 20))
	end := int(rdU32(record, 24))
	if end > len(record) {
		end = len(record)
	}
	for offset+16 <= end {
		kind := rdU32(record, offset)
		length := int(rdU32(record, offset+4))
		if kind == attrEnd || length < 16 || offset+length > end {
			return
		}
		if !fn(kind, record[offset:offset+length]) {
			return
		}
		offset += length
	}
}

func residentValue(attr []byte) []byte {
	length := int(rdU32(attr, 16))
	offset := int(rdU16(attr, 20))
	if offset > len(attr) {
		return nil
	}
	end := offset + length
	if end > len(attr) {
		end = len(attr)
	}
	return attr[offset:end]
}

// namespaceRank：Win32 / Win32+DOS 优先，其次 POSIX，最后才是 8.3 短名。
func namespaceRank(namespace uint8) uint8 {
	switch namespace {
	case 1, 3:
		return 3
	case 0:
		return 2
	case 2:
		return 1
	default:
		return 0
	}
}

func fileTimeToUnix(filetime uint64) uint32 {
	// filetime: 100ns 自 1601-01-01 起；Unix 纪元差 11644473600 秒。
	// 注意 uint64 直接减会下溢成一个巨大的正数（1601 年的文件就是这个情况），
	// 所以先比较再减 —— Rust 版用的 saturating_sub。
	const unixEpochOffset = uint64(11_644_473_600)
	ticks := filetime / 10_000_000
	if ticks <= unixEpochOffset {
		return 0
	}
	v := ticks - unixEpochOffset
	return uint32(min(v, 0xFFFFFFFF))
}

func alignUp(value, a int) int { return divCeil(value, a) * a }

func rdU16(b []byte, o int) uint16 {
	if o < 0 || o+2 > len(b) {
		return 0
	}
	return binary.LittleEndian.Uint16(b[o:])
}

func rdU32(b []byte, o int) uint32 {
	if o < 0 || o+4 > len(b) {
		return 0
	}
	return binary.LittleEndian.Uint32(b[o:])
}

func rdU64(b []byte, o int) uint64 {
	if o < 0 || o+8 > len(b) {
		return 0
	}
	return binary.LittleEndian.Uint64(b[o:])
}

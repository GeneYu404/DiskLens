package core

import (
	"encoding/binary"
	"testing"
)

func TestDecodesDataRuns(t *testing.T) {
	// 24 簇 @ LCN 0x5634；5 簇稀疏；16 簇 @ 相对偏移 -16
	b := []byte{0x21, 0x18, 0x34, 0x56, 0x01, 0x05, 0x11, 0x10, 0xF0, 0x00}
	runs := parseRuns(b)
	if len(runs) != 3 {
		t.Fatalf("解析出 %d 段, 期望 3", len(runs))
	}
	if !runs[0].lcnValid || runs[0].lcn != 0x5634 || runs[0].clusters != 24 {
		t.Errorf("第 1 段 = %+v, 期望 lcn=0x5634 clusters=24", runs[0])
	}
	if runs[1].lcnValid || runs[1].clusters != 5 {
		t.Errorf("第 2 段 = %+v, 期望稀疏 5 簇", runs[1])
	}
	if !runs[2].lcnValid || runs[2].lcn != 0x5634-16 || runs[2].clusters != 16 {
		t.Errorf("第 3 段 = %+v, 期望 lcn=0x5634-16 clusters=16", runs[2])
	}
}

func TestDetectsDriveRoots(t *testing.T) {
	cases := []struct {
		in   string
		want byte
		isOk bool
	}{
		{`C:\`, 'C', true},
		{`d:`, 'd', true},
		{`C:\Users`, 0, false},
		{``, 0, false},
		{`CC:\`, 0, false},
	}
	for _, c := range cases {
		got, ok := DriveRootLetter(c.in)
		if ok != c.isOk || (ok && got != c.want) {
			t.Errorf("DriveRootLetter(%q) = (%q, %t), 期望 (%q, %t)", c.in, got, ok, string(c.want), c.isOk)
		}
	}
}

func TestFileTimeConversion(t *testing.T) {
	// 2020-01-01T00:00:00Z
	if got := fileTimeToUnix(132_223_104_000_000_000); got != 1_577_836_800 {
		t.Errorf("fileTimeToUnix = %d, 期望 1577836800", got)
	}
	// 1601 年（纪元之前）应夹到 0，不能下溢
	if got := fileTimeToUnix(0); got != 0 {
		t.Errorf("fileTimeToUnix(0) = %d, 期望 0", got)
	}
}

func TestNamespaceRank(t *testing.T) {
	// Win32(1) 与 Win32+DOS(3) 最高，DOS(2) 最低，POSIX(0) 居中
	if namespaceRank(1) != 3 || namespaceRank(3) != 3 {
		t.Error("Win32 命名空间优先级应为最高")
	}
	if namespaceRank(0) <= namespaceRank(2) {
		t.Error("POSIX 优先级应高于 DOS")
	}
}

func TestParseBootRejectsNonNTFS(t *testing.T) {
	boot := make([]byte, 512)
	copy(boot[3:11], "FAT32   ")
	if _, err := parseBoot(boot); err == nil {
		t.Fatal("FAT32 引导扇区应当被拒绝")
	}
}

func TestApplyFixupRejectsBadChecksum(t *testing.T) {
	// 修正是「每 512 字节的末尾两字节被替换成了校验值」，
	// usa 数组里第 i 项（从 1 开始）保存第 i 个扇区该有的原始值。
	newRecord := func() []byte {
		rec := make([]byte, 1024)
		copy(rec[0:4], "FILE")
		binary.LittleEndian.PutUint16(rec[4:], 48) // usa offset
		binary.LittleEndian.PutUint16(rec[6:], 3)  // usa count = 3
		rec[48], rec[49] = 0xAA, 0xBB
		copy(rec[50:52], []byte{1, 2}) // 第 1 个扇区尾的原始值
		copy(rec[52:54], []byte{3, 4}) // 第 2 个扇区尾的原始值
		return rec
	}

	// 扇区尾与校验值不符 → 判定为写入撕裂
	rec := newRecord()
	rec[510], rec[511] = 0x00, 0x00
	if applyFixup(rec) {
		t.Fatal("校验值不匹配时 applyFixup 应返回 false")
	}

	// 校验值匹配 → 正确还原
	rec2 := newRecord()
	rec2[510], rec2[511] = 0xAA, 0xBB
	rec2[1022], rec2[1023] = 0xAA, 0xBB
	if !applyFixup(rec2) {
		t.Fatal("校验值匹配时 applyFixup 应返回 true")
	}
	if rec2[510] != 1 || rec2[511] != 2 {
		t.Errorf("第 1 个扇区尾修复后 = %v, 期望 [1 2]", rec2[510:512])
	}
	if rec2[1022] != 3 || rec2[1023] != 4 {
		t.Errorf("第 2 个扇区尾修复后 = %v, 期望 [3 4]", rec2[1022:1024])
	}
}

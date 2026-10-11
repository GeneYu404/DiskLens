//! DiskLens 命令行版本。
//!
//! ```text
//! disklens C:\ --engine auto --threads 16 --top 20
//! disklens ~/projects --engine walk --allocated
//! ```

package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"disklens/internal/core"
)

type args struct {
	path string
	opts core.ScanOptions
	top  int
}

func printHelp() {
	fmt.Fprint(os.Stderr, `用法: disklens [路径] [选项]

选项:
  -e, --engine <auto|walk|mft>  扫描引擎（默认 auto：Windows 整卷优先 MFT）
  -t, --threads <N>             线程数（默认 0 = 全部核心）
  -n, --top <N>                 每个列表显示的条数（默认 20）
      --allocated               统计实际占用空间
      --cross-fs                允许跨越挂载点
  -h, --help                    显示帮助
`)
}

func parseArgs(argv []string) (args, error) {
	var a args
	a.top = 20
	a.opts = core.DefaultScanOptions()

	need := func(i int, flag string) (string, error) {
		if i+1 >= len(argv) {
			return "", fmt.Errorf("%s 需要一个参数", flag)
		}
		return argv[i+1], nil
	}

	for i := 0; i < len(argv); i++ {
		switch argv[i] {
		case "-e", "--engine":
			v, err := need(i, argv[i])
			if err != nil {
				return a, err
			}
			a.opts.Engine = core.ParseEngine(v)
			i++
		case "-t", "--threads":
			v, err := need(i, argv[i])
			if err != nil {
				return a, err
			}
			n, err := strconv.Atoi(v)
			if err != nil {
				return a, errors.New("线程数无效")
			}
			a.opts.Threads = n
			i++
		case "-n", "--top":
			v, err := need(i, argv[i])
			if err != nil {
				return a, err
			}
			n, err := strconv.Atoi(v)
			if err != nil {
				return a, errors.New("--top 数值无效")
			}
			a.top = n
			i++
		case "--allocated":
			a.opts.AllocatedSize = true
		case "--cross-fs":
			a.opts.SameFilesystem = false
		case "-h", "--help":
			printHelp()
			os.Exit(0)
		default:
			if strings.HasPrefix(argv[i], "-") {
				return a, fmt.Errorf("未知参数：%s", argv[i])
			}
			a.path = argv[i]
		}
	}
	if a.path == "" {
		a.path = "."
	}
	return a, nil
}

func main() {
	a, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "错误：%v\n\n", err)
		printHelp()
		os.Exit(2)
	}

	progress := &core.ScanProgress{}
	var finished sync.WaitGroup
	finished.Add(1)

	// 进度线程：每 100ms 读一次原子计数器
	go func() {
		defer finished.Done()
		for !progress.IsFinished() {
			s := progress.Snapshot()
			if s.RecordsTotal > 0 && s.Files == 0 {
				fmt.Fprintf(os.Stderr, "\r读取 MFT 记录 %d/%d        ", s.RecordsDone, s.RecordsTotal)
			} else {
				fmt.Fprintf(os.Stderr, "\r已扫描 %d 个文件 · %d 个目录 · %s        ", s.Files, s.Dirs, human(s.Bytes))
			}
			time.Sleep(100 * time.Millisecond)
		}
		fmt.Fprint(os.Stderr, "\r"+strings.Repeat(" ", 80)+"\r")
	}()

	outcome, err := core.Scan(a.path, a.opts, progress)
	progress.MarkFinished()
	finished.Wait()

	if err != nil {
		fmt.Fprintf(os.Stderr, "扫描失败：%v\n", err)
		os.Exit(1)
	}
	report(outcome, a.top)
}

func report(outcome *core.ScanOutcome, top int) {
	tree := outcome.Tree
	summary := core.Summary(tree)

	fmt.Printf("DiskLens · %s\n", summary.Root)
	fmt.Printf("引擎：%s    用时：%.2fs\n", outcome.EngineUsed.Label(), outcome.Elapsed.Seconds())
	if outcome.FallbackReason != "" {
		fmt.Printf("提示：%s\n", outcome.FallbackReason)
	}
	if outcome.Cancelled {
		fmt.Println("注意：扫描被取消，结果不完整")
	}
	fmt.Printf("文件 %d    目录 %d    总大小 %s    树内存 %s\n",
		summary.Files, summary.Dirs, human(summary.Bytes), human(uint64(summary.MemoryBytes)))

	fmt.Printf("\n最大的 %d 个直接子项：\n", top)
	// Children 已经按大小降序串好，直接取前 top 个即可，不必再排序
	for i, id := range tree.Children(0) {
		if top > 0 && i >= top {
			break
		}
		node := tree.Node(id)
		suffix := ""
		if tree.IsDir(id) {
			suffix = `\`
		}
		fmt.Printf("  %10s  %5.1f%%  %9d 个文件  %s%s\n",
			human(node.Size), percent(node.Size, summary.Bytes), node.FileCount, tree.Name(id), suffix)
	}

	fmt.Printf("\n最大的 %d 个文件：\n", top)
	for _, hit := range core.TopFilesOf(tree, top) {
		fmt.Printf("  %10s  %s\n", human(hit.Size), hit.Path)
	}

	fmt.Println("\n占用最多的扩展名：")
	for i, stat := range tree.ExtStats() {
		if i >= 10 {
			break
		}
		ext := stat.Ext
		if ext == "" {
			ext = "(无扩展名)"
		} else {
			ext = "." + ext
		}
		fmt.Printf("  %10s  %9d 个  %s\n", human(stat.Size), stat.Count, ext)
	}
}

func percent(part, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return float64(part) * 100 / float64(total)
}

func human(bytes uint64) string {
	units := [...]string{"B", "KB", "MB", "GB", "TB", "PB"}
	value := float64(bytes)
	unit := 0
	for value >= 1024 && unit < len(units)-1 {
		value /= 1024
		unit++
	}
	if unit == 0 {
		return fmt.Sprintf("%d B", bytes)
	}
	return fmt.Sprintf("%.2f %s", value, units[unit])
}

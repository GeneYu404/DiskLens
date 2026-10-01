//! DiskLens 命令行版本。
//!
//! ```text
//! disklens C:\ --engine auto --threads 16 --top 20
//! disklens ~/projects --engine walk --allocated
//! ```

use disklens_core::{query, scan, Engine, ScanOptions, ScanOutcome, ScanProgress};
use std::path::{PathBuf, MAIN_SEPARATOR};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::{env, io, process, thread};

struct Args {
    path: PathBuf,
    opts: ScanOptions,
    top: usize,
}

fn print_help() {
    eprintln!(
        "用法: disklens [路径] [选项]

选项:
  -e, --engine <auto|walk|mft>  扫描引擎（默认 auto：Windows 整卷优先 MFT）
  -t, --threads <N>             线程数（默认 0 = 全部核心）
  -n, --top <N>                 每个列表显示的条数（默认 20）
      --allocated               统计实际占用空间（Unix）
      --cross-fs                允许跨越挂载点
  -h, --help                    显示帮助"
    );
}

fn parse_args() -> Result<Args, String> {
    let mut path = None;
    let mut opts = ScanOptions::default();
    let mut top = 20usize;
    let mut args = env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-e" | "--engine" => opts.engine = Engine::parse(&args.next().ok_or("--engine 需要一个参数")?),
            "-t" | "--threads" => {
                opts.threads = args.next().ok_or("--threads 需要一个参数")?.parse::<usize>().map_err(|_| "线程数无效")?;
            }
            "-n" | "--top" => {
                top = args.next().ok_or("--top 需要一个参数")?.parse::<usize>().map_err(|_| "--top 数值无效")?;
            }
            "--allocated" => opts.allocated_size = true,
            "--cross-fs" => opts.same_filesystem = false,
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            other if other.starts_with('-') => return Err(format!("未知参数：{other}")),
            other => path = Some(PathBuf::from(other)),
        }
    }

    Ok(Args { path: path.unwrap_or_else(|| PathBuf::from(".")), opts, top })
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("错误：{message}\n");
            print_help();
            process::exit(2);
        }
    };

    let progress = Arc::new(ScanProgress::default());
    let finished = Arc::new(AtomicBool::new(false));

    // 进度线程：每 100ms 读一次原子计数器
    let reporter = {
        let progress = progress.clone();
        let finished = finished.clone();
        thread::spawn(move || {
            while !finished.load(Ordering::Relaxed) {
                let s = progress.snapshot();
                if s.records_total > 0 && s.files == 0 {
                    eprint!("\r读取 MFT 记录 {}/{}        ", s.records_done, s.records_total);
                } else {
                    eprint!("\r已扫描 {} 个文件 · {} 个目录 · {}        ", s.files, s.dirs, human(s.bytes));
                }
                thread::sleep(Duration::from_millis(100));
            }
            eprint!("\r{}\r", " ".repeat(80));
        })
    };

    // 扫描线程：给足栈空间
    let worker = {
        let progress = progress.clone();
        let path = args.path.clone();
        let opts = args.opts.clone();
        thread::Builder::new()
            .name("disklens-scan".into())
            .stack_size(64 << 20)
            .spawn(move || scan(&path, &opts, &progress))
            .expect("无法创建扫描线程")
    };

    let result = worker.join().unwrap_or_else(|_| Err(io::Error::other("扫描线程崩溃")));
    finished.store(true, Ordering::Relaxed);
    let _ = reporter.join();

    match result {
        Ok(outcome) => report(&outcome, args.top),
        Err(error) => {
            eprintln!("扫描失败：{error}");
            process::exit(1);
        }
    }
}

fn report(outcome: &ScanOutcome, top: usize) {
    let tree = &outcome.tree;
    let summary = query::summary(tree);

    println!("DiskLens · {}", summary.root);
    println!("引擎：{}    用时：{:.2?}", outcome.engine_used.label(), outcome.elapsed);
    if let Some(reason) = &outcome.fallback_reason {
        println!("提示：{reason}");
    }
    if outcome.cancelled {
        println!("注意：扫描被取消，结果不完整");
    }
    println!(
        "文件 {}    目录 {}    总大小 {}    树内存 {}",
        summary.files,
        summary.dirs,
        human(summary.bytes),
        human(summary.memory_bytes as u64)
    );

    println!("\n最大的 {top} 个直接子项：");
    for id in tree.children(0).take(top) {
        let node = tree.node(id);
        let suffix = if tree.is_dir(id) { MAIN_SEPARATOR.to_string() } else { String::new() };
        println!(
            "  {:>10}  {:>5.1}%  {:>9} 个文件  {}{}",
            human(node.size),
            percent(node.size, summary.bytes),
            node.file_count,
            tree.name(id),
            suffix
        );
    }

    println!("\n最大的 {top} 个文件：");
    for hit in query::top_files(tree, top) {
        println!("  {:>10}  {}", human(hit.size), hit.path);
    }

    println!("\n占用最多的扩展名：");
    for stat in tree.ext_stats().into_iter().take(10) {
        let ext = if stat.ext.is_empty() { "(无扩展名)" } else { stat.ext.as_str() };
        println!("  {:>10}  {:>9} 个  .{}", human(stat.size), stat.count, ext);
    }
}

fn percent(part: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        part as f64 * 100.0 / total as f64
    }
}

fn human(bytes: u64) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.2} {}", UNITS[unit])
    }
}

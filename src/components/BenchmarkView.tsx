import { useState } from "react";
import { Cpu, HardDrive, Zap } from "lucide-react";

// 柱形系列色：按“越快越受推荐”的角色取自设计令牌（慢=中性灰，推荐路线=accent，最快=success）。
const METHODS = [
  { name: "Python os.walk + stat", seconds: 65, detail: "解释器开销；逐文件读取元数据", color: "var(--text-3)" },
  { name: "Python os.scandir", seconds: 28, detail: "复用目录项属性，减少 stat 调用", color: "var(--text-2)" },
  { name: "Rust / C++ 单线程", seconds: 11, detail: "原生遍历，受单核与目录寻址限制", color: "var(--dv-2)" },
  { name: "Rust Rayon 多线程", seconds: 3.8, detail: "工作窃取并行扫描，通用文件系统路线", color: "var(--accent)" },
  { name: "NTFS $MFT 元数据读取", seconds: 1.2, detail: "顺序读取 NTFS 元数据；需要管理员权限", color: "var(--success)" },
  { name: "USN Journal 增量更新", seconds: 0.05, detail: "首次建索引后，仅处理变更记录", color: "var(--dv-6)" },
];

export default function BenchmarkView() {
  const [fileCount, setFileCount] = useState(1_000_000);
  const [disk, setDisk] = useState<"nvme" | "sata" | "hdd">("nvme");
  const multiplier = disk === "nvme" ? 1 : disk === "sata" ? 2.4 : 9.5;
  const max = 65 * fileCount / 1_000_000 * multiplier;

  return (
    <div className="h-full overflow-auto bg-card px-6 py-5 text-fg">
      <div className="flex flex-wrap items-start justify-between gap-5 border-b border-stroke pb-5">
        <div>
          <div className="flex items-center gap-2"><GaugeIcon /><h2 className="text-[16px] font-semibold">扫描性能模型</h2></div>
          <p className="mt-1.5 text-[12px] text-fg2">以百万文件规模估算不同扫描方式的时间与适用场景</p>
        </div>
        <div className="flex flex-wrap items-center gap-5 rounded-lg border border-stroke bg-layer-solid px-4 py-3">
          <label className="min-w-[190px]"><span className="mb-1 block text-[10px] text-fg2">模拟文件数量：<b className="text-fg">{(fileCount / 10_000).toFixed(0)} 万</b></span><input type="range" min={200_000} max={5_000_000} step={200_000} value={fileCount} onChange={(e) => setFileCount(Number(e.target.value))} className="w-full accent-accent" /></label>
          <label className="text-[10px] text-fg2">存储介质<select value={disk} onChange={(e) => setDisk(e.target.value as typeof disk)} className="mt-1 block h-7 rounded border border-stroke bg-card px-2 text-[11px] text-fg outline-none"><option value="nvme">PCIe NVMe</option><option value="sata">SATA SSD</option><option value="hdd">机械硬盘</option></select></label>
        </div>
      </div>

      <section className="py-5">
        <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold"><Zap className="h-4 w-4 text-accent" />预计扫描耗时 <span className="font-normal text-fg2">（参考值，非实测）</span></div>
        <div className="space-y-4">
          {METHODS.map((method) => {
            const seconds = method.seconds * fileCount / 1_000_000 * multiplier;
            const label = seconds < 1 ? `${Math.round(seconds * 1000)} 毫秒` : `${seconds.toFixed(1)} 秒`;
            return <div key={method.name} className="grid grid-cols-[210px_minmax(0,1fr)_82px] items-center gap-4 max-sm:grid-cols-[1fr_72px]">
              <div className="min-w-0"><div className="truncate text-[12px] font-medium">{method.name}</div><div className="mt-0.5 truncate text-[10px] text-fg2">{method.detail}</div></div>
              <div className="h-2 overflow-hidden rounded-full bg-layer-solid max-sm:col-span-2 max-sm:row-start-2"><div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(2, seconds / max * 100)}%`, background: method.color }} /></div>
              <span className="text-right font-semibold tabular-nums text-fg">{label}</span>
            </div>;
          })}
        </div>
      </section>

      <div className="grid gap-5 border-t border-stroke pt-5 md:grid-cols-3">
        <Insight icon={<HardDrive className="h-4 w-4" />} title="扫描方式" text="目录遍历可用于多种文件系统；NTFS 元数据直读需要管理员权限并处理硬链接、稀疏文件等边界情况。" />
        <Insight icon={<Cpu className="h-4 w-4" />} title="数据结构" text="扁平数组与字符串池减少节点分配和指针开销；目录大小在扫描阶段自底向上归约。" />
        <Insight icon={<Zap className="h-4 w-4" />} title="界面渲染" text="虚拟列表按视口绘制，树图在 Canvas 中批量布局，小于像素阈值的区域不参与绘制。" />
      </div>
    </div>
  );
}

function GaugeIcon() {
  return <div className="grid h-7 w-7 place-items-center rounded-md bg-accent-soft text-accent"><Cpu className="h-4 w-4" /></div>;
}

function Insight({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="flex gap-3"><span className="mt-0.5 text-accent">{icon}</span><div><h3 className="text-[12px] font-semibold">{title}</h3><p className="mt-1 text-[11px] leading-relaxed text-fg2">{text}</p></div></div>;
}
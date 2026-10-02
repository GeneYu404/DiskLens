// 发布版在 Windows 上不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;

fn main() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_drives,
            commands::check_elevation,
            commands::start_scan,
            commands::scan_progress,
            commands::cancel_scan,
            commands::tree_summary,
            commands::get_node,
            commands::get_children,
            commands::node_path,
            commands::top_files,
            commands::ext_stats,
            commands::search,
            commands::export_snapshot,
            commands::delete_to_trash,
            commands::reveal_in_explorer,
        ])
        .run(tauri::generate_context!())
        .expect("启动 DiskLens 失败");
}

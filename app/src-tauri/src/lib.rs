//! Ferra Visualizer: the Tauri backend. Opens a Ferra chain file, verifies it, serves the
//! automatic report and the manual graph, and reaches the public indexers when the UI asks for
//! online data.

pub mod commands;
pub mod error;
pub mod graph;
pub mod online;
pub mod report;
pub mod state;
pub mod validator;

use std::sync::{Arc, Mutex};

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let fixtures = commands::fixtures_dir(&handle);
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("ferra-visualizer"));
            let state = state::AppState {
                opened: Mutex::new(None),
                verdicts: Mutex::new(Default::default()),
                auto: Mutex::new(Default::default()),
                online: Arc::new(online::Online::new(fixtures)),
                recent: Mutex::new(Vec::new()),
                data_dir,
            };
            let recent = state.load_recent();
            if let Ok(mut r) = state.recent.lock() {
                *r = recent;
            }
            app.manage(state);
            // `ferra-visualizer <chain.jsonl>` opens the file straight away.
            if let Some(arg) = std::env::args().nth(1).filter(|a| !a.starts_with('-')) {
                let path = std::path::PathBuf::from(&arg);
                if path.is_file()
                    && let Some(st) = handle.try_state::<state::AppState>()
                {
                    match state::open_file(&path).and_then(|o| commands::install(&handle, &st, o)) {
                        Ok(s) => eprintln!("opened {} ({} events)", s.file.name, s.file.events),
                        Err(e) => eprintln!("could not open {arg}: {e}"),
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_chain,
            commands::open_demo,
            commands::reload_chain,
            commands::close_chain,
            commands::current_chain,
            commands::list_recent,
            commands::forget_recent,
            commands::app_info,
            commands::list_events,
            commands::validate_start,
            commands::validate_stop,
            commands::validation_status,
            commands::manual_verdict,
            commands::get_event,
            commands::get_report,
            commands::get_profile,
            commands::get_dataset,
            commands::export_file,
            commands::expand_node,
            commands::node_insight,
            commands::event_report,
            commands::provenance_check,
            commands::risk_preview,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("error while running Ferra Visualizer: {e}");
            std::process::exit(1);
        });
}

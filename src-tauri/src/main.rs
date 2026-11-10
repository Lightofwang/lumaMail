// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mail;

use mail::commands;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::account_list,
            commands::account_test,
            commands::account_save,
            commands::account_delete,
            commands::folder_list,
            commands::message_list,
            commands::message_get,
            commands::message_set_flags,
            commands::message_move,
            commands::message_delete,
            commands::message_send,
            commands::attachment_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

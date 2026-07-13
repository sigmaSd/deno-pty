use crossbeam::channel::{Receiver, Sender, unbounded};
use portable_pty::{
    ChildKiller as Ck, CommandBuilder, MasterPty, PtySize, SlavePty, native_pty_system,
};
use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    ffi::{CString, c_char},
    io::Read,
    mem::forget,
    slice,
    time::Duration,
};
mod utils;
use utils::boxed_error_to_cstring;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub struct Pty {
    reader: PtyReader,
    tx_write: Sender<String>,
    // keep the slave alive
    // so windows works
    // https://github.com/wez/wezterm/issues/4206
    _slave: Box<dyn SlavePty + Send>,
    master: Box<dyn MasterPty + Send>,
    // use to end the spawned process
    ck: Box<dyn Ck>,
}

#[derive(Clone)]
struct PtyReader {
    rx_read: Receiver<Message>,
    exit_status: Cell<Option<u32>>,
    /// Incomplete UTF-8 tail carried between string-API reads. A chunk can end
    /// mid-codepoint (guaranteed under heavy CJK/emoji/TUI output); the tail
    /// (at most 3 bytes) is prepended to the next read before decoding.
    pending_utf8: RefCell<Vec<u8>>,
}
impl PtyReader {
    fn new(rx_read: Receiver<Message>) -> PtyReader {
        Self {
            rx_read,
            exit_status: Cell::new(None),
            pending_utf8: RefCell::new(Vec::new()),
        }
    }

    /// Decode bytes as UTF-8 for the string API, carrying an incomplete
    /// trailing sequence into the next call instead of erroring. Genuinely
    /// invalid bytes mid-stream (binary output) decode lossily.
    fn decode_utf8_carry(&self, bytes: Vec<u8>) -> String {
        let mut pending = self.pending_utf8.borrow_mut();
        let mut all = std::mem::take(&mut *pending);
        all.extend_from_slice(&bytes);
        match String::from_utf8(all) {
            Ok(s) => s,
            Err(e) => {
                let valid_up_to = e.utf8_error().valid_up_to();
                let error_len = e.utf8_error().error_len();
                let all = e.into_bytes();
                if error_len.is_none() {
                    // Incomplete sequence at the very end: keep the tail.
                    *pending = all[valid_up_to..].to_vec();
                    // SAFETY: from_utf8 validated everything below valid_up_to.
                    unsafe { String::from_utf8_unchecked(all[..valid_up_to].to_vec()) }
                } else {
                    String::from_utf8_lossy(&all).into_owned()
                }
            }
        }
    }
    //NOTE: this function should not block
    fn read(&self) -> Result<Message> {
        if let Some(exit_code) = self.exit_status.get() {
            return Ok(Message::End(exit_code));
        }

        let mut msgs: Vec<_> = self.rx_read.try_iter().collect();

        let exit_msg = msgs
            .iter()
            .find(|msg| matches!(msg, Message::End(_)))
            .cloned();

        if let Some(Message::End(exit_code)) = exit_msg {
            self.exit_status.set(Some(exit_code));

            // NOTE: We received the END message, this means that the process has exited
            // But there could be some pending messages in the read channel, this is especisally true in windows
            // So sleep a bit and check the channel again
            std::thread::sleep(Duration::from_millis(100));
            msgs.extend(self.rx_read.try_iter());

            // Filter out the End message itself after collecting potentially pending data
            msgs.retain(|msg| !matches!(msg, Message::End(_)));

            if msgs.is_empty() {
                return Ok(Message::End(exit_code)); // Truly the end if no data remains
            }
            // If only End was received initially but more data came in the retry,
            // we proceed to bundle the data below.
        }

        // msgs is empty but we didn't receive End Message
        if msgs.is_empty() {
            // No data, no end signal yet
            return Ok(Message::Data(Vec::new()));
        }

        let mut combined_data: Vec<u8> = Vec::new();
        for msg in &msgs {
            if let Message::Data(data) = msg {
                combined_data.extend_from_slice(data);
            } else {
                unreachable!("we already filtered End messages")
            }
        }

        Ok(Message::Data(combined_data))
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct Command {
    cmd: String,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    cwd: Option<String>,
    size: Option<PtySize>,
}

#[derive(PartialEq, Eq, Debug, Clone)]
enum Message {
    Data(Vec<u8>),
    End(u32),
}

#[cfg(windows)]
struct CursorQueryWatcher {
    tail: Vec<u8>,
}

#[cfg(windows)]
impl CursorQueryWatcher {
    const QUERY: &'static [u8] = b"\x1b[6n";
    const RESPONSE: &'static str = "\x1b[1;1R";

    fn new() -> Self {
        Self { tail: Vec::new() }
    }

    fn scan_and_strip(&mut self, chunk: &[u8]) -> (Vec<u8>, usize) {
        let mut buf = std::mem::take(&mut self.tail);
        buf.extend_from_slice(chunk);

        let mut cleaned = Vec::with_capacity(buf.len());
        let mut count = 0;
        let mut i = 0;
        while i < buf.len() {
            if buf[i..].len() >= Self::QUERY.len() && &buf[i..i + Self::QUERY.len()] == Self::QUERY
            {
                count += 1;
                i += Self::QUERY.len();
            } else {
                cleaned.push(buf[i]);
                i += 1;
            }
        }

        let keep = Self::QUERY.len() - 1;
        let check_from = cleaned.len().saturating_sub(keep);
        let mut split_at = cleaned.len();
        for start in check_from..cleaned.len() {
            if Self::QUERY.starts_with(&cleaned[start..]) {
                split_at = start;
                break;
            }
        }
        self.tail = cleaned.split_off(split_at);
        (cleaned, count)
    }
}

impl Pty {
    fn create(command: Command) -> Result<Self> {
        let pty_system = native_pty_system();
        // Open at the requested size so the child never observes the default
        // grid: with a spawn-then-resize dance the shell can win the race and
        // print its first prompt at 80 cols, which reflows into stray blank
        // lines once the real size lands.
        let pair = pty_system.openpty(command.size.unwrap_or(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }))?;

        let mut cmd_builder = CommandBuilder::new(command.cmd);
        // https://github.com/wez/wezterm/issues/4205
        cmd_builder.env("PATH", std::env::var("PATH")?);
        if let Some(args) = command.args {
            cmd_builder.args(&args);
        }
        match command.cwd {
            Some(cwd) => cmd_builder.cwd(cwd),
            None => cmd_builder.cwd(std::env::current_dir()?),
        }
        if let Some(map) = command.env {
            for (key, val) in map {
                cmd_builder.env(key, val);
            }
        }

        let (tx_read, rx_read) = unbounded();
        let slave = pair.slave; // Keep slave handle

        // Spawn the command
        let mut child = slave.spawn_command(cmd_builder)?;
        let ck = child.clone_killer();

        // If we do a pty.read after the process exit, read will hang
        // Thats why we spawn another thread to wait for the child
        // and signal its exit
        let tx_read_c = tx_read.clone();
        std::thread::spawn(move || {
            let exit_code = child.wait().map(|r| r.exit_code()).unwrap_or(12345); // internal error code
            let _ = tx_read_c.send(Message::End(exit_code));
        });

        // Thread for writing to PTY input
        let mut writer = pair.master.take_writer()?;
        let (tx_write, rx_write): (Sender<String>, _) = unbounded();
        std::thread::spawn(move || {
            while let Ok(data_to_write) = rx_write.recv() {
                if writer.write_all(data_to_write.as_bytes()).is_err() {
                    eprintln!("Error writing to PTY");
                    break;
                }
            }
        });

        // Read the output in another thread.
        // This is important because it is easy to encounter a situation
        // where read/write buffers fill and block either your process
        // or the spawned process.
        let mut reader = pair.master.try_clone_reader()?;
        let tx_read_reader_thread = tx_read.clone();
        #[cfg(windows)]
        let tx_write_for_cursor = tx_write.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 8 * 1024];
            #[cfg(windows)]
            let mut cursor_watcher = CursorQueryWatcher::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        #[cfg(windows)]
                        let forward = {
                            let (cleaned, queries) = cursor_watcher.scan_and_strip(&buf[..n]);
                            for _ in 0..queries {
                                let _ = tx_write_for_cursor
                                    .send(CursorQueryWatcher::RESPONSE.to_string());
                            }
                            cleaned
                        };
                        #[cfg(not(windows))]
                        let forward = buf[..n].to_vec();

                        if forward.is_empty() {
                            continue;
                        }
                        if tx_read_reader_thread.send(Message::Data(forward)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Error reading from PTY: {}", e);
                        break;
                    }
                }
            }
        });

        Ok(Self {
            reader: PtyReader::new(rx_read),
            tx_write,
            _slave: slave, // Keep slave alive
            master: pair.master,
            ck,
        })
    }

    #[allow(dead_code)]
    fn clone_reader(&self) -> PtyReader {
        self.reader.clone()
    }

    fn read(&self) -> Result<Message> {
        self.reader.read()
    }

    fn write(&self, data: String) -> Result<()> {
        // Sending might fail if the writing thread panicked/exited
        self.tx_write.send(data).map_err(|e| e.into())
    }

    fn resize(&self, size: PtySize) -> Result<()> {
        self.master.resize(size).map_err(Into::into)
    }

    fn get_size(&self) -> Result<PtySize> {
        self.master.get_size().map_err(Into::into)
    }
}

// note: need to be careful with names with no_mangle extern C
// for example extern C write, will cause weird bugs
// == FFI Layer ==

/// Creates a new Pty instance.
///
/// # Safety
/// - `command_ptr` must point to a valid UTF-8 encoded JSON string representing the `Command` struct.
/// - `command_len` must be the correct byte length of the JSON string pointed to by `command_ptr`.
/// - `result_ptr` must point to a valid buffer where the pointer to the created Pty object will be written on success,
///   or where the pointer to a C-string error message will be written on failure.
///
/// # Returns
/// - `0` on success. The `usize` at `result_ptr` holds the opaque pointer to the `Pty`.
/// - `-1` on error. The `usize` at `result_ptr` holds a pointer to a null-terminated C string
///   containing the error message. This string must be freed by the caller using `free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_create(
    command_ptr: *const u8,
    command_len: usize,
    result_ptr: *mut usize,
) -> i8 {
    let pty_result = (|| -> Result<Box<Pty>> {
        // Create a slice from the pointer and length
        let command_slice = unsafe { slice::from_raw_parts(command_ptr, command_len) };
        // Deserialize from the slice
        let command: Command = serde_json::from_slice(command_slice)?;
        // dbg!("Creating PTY with command: {:?}", &command);
        let pty = Pty::create(command)?;
        Ok(Box::new(pty))
    })();

    match pty_result {
        Ok(pty) => {
            unsafe { *result_ptr = Box::into_raw(pty) as usize };
            0 // Success
        }
        Err(err) => {
            unsafe { *result_ptr = boxed_error_to_cstring(err).into_raw() as _ };
            -1 // Error
        }
    }
}

/// Reads pending output from the Pty. This is non-blocking.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`.
/// - `result_ptr` must point to a valid buffer where the result pointer will be written.
///
/// # Returns
/// - `0`: Success, data read. `result_ptr` holds a pointer to a null-terminated C string (UTF-8)
///   containing the data. This string must be freed by the caller using `free_string`. Empty string means no new data available currently.
// - `99`: Process exited normally, no more data will ever be available. `result_ptr` is not modified or set to null.
/// - `-1`: Error occurred. `result_ptr` holds a pointer to a null-terminated C string
///   containing the error message. This string must be freed by the caller using `free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_read(pty_ptr: *mut Pty, result_ptr: *mut usize) -> i8 {
    let pty = unsafe { &*pty_ptr };
    match pty.read() {
        Ok(Message::Data(bytes)) => {
            let data = pty.reader.decode_utf8_carry(bytes);
            match CString::new(data) {
                // Handles potential null bytes in data
                Ok(c_string) => {
                    unsafe { *result_ptr = c_string.into_raw() as _ };
                    0 // Success with data
                }
                Err(e) => {
                    // Data contained null bytes, shouldn't happen with valid UTF-8 read often, but handle it.
                    let err_str = format!("Failed to create CString from read data: {}", e);
                    unsafe { *result_ptr = boxed_error_to_cstring(err_str.into()).into_raw() as _ };
                    -1 // Error
                }
            }
        }
        Ok(Message::End(code)) => {
            let status = CString::new(code.to_string()).expect("failed to create cstring");
            unsafe { *result_ptr = status.into_raw() as _ };
            99 // Process exited
        }
        Err(err) => {
            unsafe { *result_ptr = boxed_error_to_cstring(err).into_raw() as _ };
            -1 // Error
        }
    }
}

/// Reads pending PTY output as RAW BYTES (no UTF-8 decoding).
///
/// `result_ptr` must point to a buffer of TWO usize slots:
/// - status `0`:  slot0 = data pointer (or null if no data), slot1 = length in
///   bytes. Free with `free_data(ptr, len)`. A null pointer with length 0 just
///   means "no data available right now".
/// - status `99`: process exited; slot0 = exit code, slot1 = 0.
/// - status `-1`: error; slot0 = error CString pointer (free with
///   `free_string`), slot1 = 0.
///
/// Unlike `pty_read`, chunk boundaries splitting a UTF-8 codepoint are the
/// caller's concern (e.g. decode with a streaming TextDecoder), and interior
/// NUL bytes in the stream are passed through instead of erroring.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`.
/// - `result_ptr` must point to a writable buffer of at least 2 usize values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_read_bytes(pty_ptr: *mut Pty, result_ptr: *mut usize) -> i8 {
    let pty = unsafe { &*pty_ptr };
    let out = unsafe { slice::from_raw_parts_mut(result_ptr, 2) };
    match pty.read() {
        Ok(Message::Data(mut bytes)) => {
            if bytes.is_empty() {
                out[0] = 0;
                out[1] = 0;
                return 0;
            }
            bytes.shrink_to_fit();
            debug_assert_eq!(bytes.len(), bytes.capacity());
            let len = bytes.len();
            let ptr = bytes.as_mut_ptr();
            forget(bytes);
            out[0] = ptr as usize;
            out[1] = len;
            0
        }
        Ok(Message::End(code)) => {
            out[0] = code as usize;
            out[1] = 0;
            99
        }
        Err(err) => {
            out[0] = boxed_error_to_cstring(err).into_raw() as usize;
            out[1] = 0;
            -1
        }
    }
}

/// Writes data to the Pty's input.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`.
/// - `data_ptr` must point to a valid null-terminated C string (UTF-8) managed by the caller (e.g., JavaScript/TypeScript).
///   Rust will borrow this data but not take ownership or free it.
/// - `error_ptr` must point to a valid buffer where a C-string error message pointer
///   will be written on failure.
///
/// # Returns
/// - `0` on success.
/// - `-1` on error. `error_ptr` holds a pointer to a null-terminated C string (allocated by Rust)
///   containing the error message. This string must be freed by the caller using `free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_write(
    pty_ptr: *mut Pty,
    data_ptr: *const c_char,
    error_ptr: *mut usize,
) -> i8 {
    // Ensure the pointer isn't null before creating CStr
    if data_ptr.is_null() {
        let err = Box::<dyn std::error::Error>::from("pty_write received null data pointer");
        unsafe { *error_ptr = boxed_error_to_cstring(err).into_raw() as _ };
        return -1;
    }

    let pty = unsafe { &*pty_ptr };
    // Borrow the C string data without taking ownership.
    // This is safe assuming data_ptr points to a valid, null-terminated C string.
    let data_cstr = unsafe { std::ffi::CStr::from_ptr(data_ptr) };

    match (|| -> Result<()> {
        // Convert borrowed CStr to borrowed Rust &str
        let data_str_borrowed = data_cstr.to_str()?;
        // Convert to owned String because the channel sender likely requires 'static data
        let data_str_owned = data_str_borrowed.to_owned();
        // Send the owned String through the channel
        pty.write(data_str_owned)?;
        Ok(())
    })() {
        Ok(()) => 0, // Success
        Err(err) => {
            unsafe { *error_ptr = boxed_error_to_cstring(err).into_raw() as _ };
            -1 // Error
        }
    }
}

/// Gets the current terminal size of the Pty.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`.
/// - `result_data_ptr` must point to a valid buffer where the pointer to the
///   serialized `PtySize` data (JSON bytes) will be written on success.
/// - `result_len_ptr` must point to a valid buffer where the length of the
///   serialized data will be written on success.
/// - `error_ptr` must point to a valid buffer where a C-string error message pointer
///   will be written on failure.
///
/// # Returns
/// - `0` on success. `result_data_ptr` and `result_len_ptr` are populated. The data
///   pointed to by `result_data_ptr` must be freed by the caller using `free_data`.
/// - `-1` on error. `error_ptr` holds a pointer to a null-terminated C string
///   containing the error message. This string must be freed by the caller using `free_string`.
///   `result_data_ptr` and `result_len_ptr` are not guaranteed to be valid.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_get_size(
    pty_ptr: *mut Pty,
    result_data_ptr: *mut *mut u8,
    result_len_ptr: *mut usize,
    error_ptr: *mut usize,
) -> i8 {
    let pty = unsafe { &*pty_ptr };
    match (|| -> Result<Vec<u8>> {
        let size = pty.get_size()?;
        // Serialize directly to Vec<u8> (JSON bytes)
        Ok(serde_json::to_vec(&size)?)
    })() {
        Ok(mut data_vec) => {
            // Ensure the vector has capacity == length for from_raw_parts later
            data_vec.shrink_to_fit();
            let ptr = data_vec.as_mut_ptr();
            let len = data_vec.len();

            // Prevent Rust from dropping the Vec's memory
            forget(data_vec);

            // Write the pointer and length back to the caller
            unsafe { *result_data_ptr = ptr };
            unsafe { *result_len_ptr = len };
            0 // Success
        }
        Err(err) => {
            unsafe { *error_ptr = boxed_error_to_cstring(err).into_raw() as _ };
            // Set output pointers to null/zero on error for clarity
            unsafe { *result_data_ptr = std::ptr::null_mut() };
            unsafe { *result_len_ptr = 0 };
            -1 // Error
        }
    }
}

/// Resizes the terminal dimensions of the Pty.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`.
/// - `size_ptr` must point to a valid UTF-8 encoded JSON string representing the `PtySize` struct.
/// - `size_len` must be the correct byte length of the JSON string pointed to by `size_ptr`.
/// - `error_ptr` must point to a valid buffer where a C-string error message pointer
///   will be written on failure.
///
/// # Returns
/// - `0` on success.
/// - `-1` on error. `error_ptr` holds a pointer to a null-terminated C string
///   containing the error message. This string must be freed by the caller using `free_string`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_resize(
    pty_ptr: *mut Pty,
    size_ptr: *const u8,
    size_len: usize,
    error_ptr: *mut usize,
) -> i8 {
    let pty = unsafe { &*pty_ptr };
    match (|| -> Result<()> {
        let size_slice = unsafe { slice::from_raw_parts(size_ptr, size_len) };
        let size: PtySize = serde_json::from_slice(size_slice)?;
        pty.resize(size)?;
        Ok(())
    })() {
        Ok(()) => 0, // Success
        Err(err) => {
            unsafe { *error_ptr = boxed_error_to_cstring(err).into_raw() as _ };
            -1 // Error
        }
    }
}

/// Closes the Pty and attempts to kill the associated child process.
///
/// # Safety
/// - `pty_ptr` must be a valid pointer obtained from `pty_create`. It will be consumed (dropped) by this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pty_close(pty_ptr: *mut Pty) {
    if pty_ptr.is_null() {
        return;
    }
    // Take ownership of the Box<Pty> to drop it
    let mut pty = unsafe { Box::from_raw(pty_ptr) };

    // Attempt to kill the child process. Ignore errors (best effort).
    // On Windows, killing might be less reliable or have side effects.
    let _ = pty.ck.kill();

    // pty is dropped automatically here, closing handles and potentially
    // signaling threads to exit if they check channel status.
}

/// Frees a null-terminated C string previously allocated by Rust and passed to the caller.
///
/// # Safety
/// - `ptr` must be a pointer previously returned by a `pty_*` function that allocated
///   an error message or data string (e.g., from `pty_read`, `pty_create` on error).
/// - `ptr` must not have been already freed.
/// - `ptr` must point to a valid C string allocated via `CString::into_raw`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        // Reconstruct the CString from the raw pointer, taking ownership back.
        // Dropping the CString deallocates the memory.
        let _ = unsafe { CString::from_raw(ptr) };
    }
}

/// Frees raw byte data previously allocated by Rust and passed to the caller.
///
/// # Safety
/// - `ptr` must be a pointer previously returned by a `pty_*` function that allocated
///   raw data (e.g., the data pointer from `pty_get_size`).
/// - `len` must be the corresponding length returned alongside the pointer.
/// - The memory region (`ptr`, `len`) must not have been already freed.
/// - The memory must have been allocated originally via `Vec<u8>` and leaked using `forget`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_data(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        // Reconstruct the Vec<u8> from the raw parts, taking ownership back.
        // Using 'len' for capacity is correct here because we assume it came from
        // a Vec where len == capacity after shrink_to_fit().
        let _ = unsafe { Vec::from_raw_parts(ptr, len, len) };
        // Dropping the Vec deallocates the memory.
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    #[test]
    fn spawn_size() {
        let pty = Pty::create(Command {
            cmd: if cfg!(windows) { "cmd" } else { "echo" }.into(),
            args: Some(vec!["hello".into()]),
            env: None,
            cwd: None,
            size: Some(PtySize {
                rows: 33,
                cols: 61,
                pixel_width: 0,
                pixel_height: 0,
            }),
        })
        .unwrap();
        assert!(matches!(
            pty.get_size(),
            Ok(PtySize {
                rows: 33,
                cols: 61,
                ..
            })
        ));
    }

    #[test]
    fn it_works() {
        let mut threads = vec![];
        for _ in 0..10 {
            threads.push(std::thread::spawn(|| {
                let pty = Pty::create(Command {
                    cmd: "deno".into(),
                    args: Some(vec!["repl".into()]),
                    env: Some([("NO_COLOR".into(), "1".into())].into()),
                    cwd: None,
                    size: None,
                })
                .unwrap();

                // read header
                pty.read().unwrap();

                let write_and_expect = |to_write: &'static str, expect: &'static str| {
                    pty.write(to_write.into()).unwrap();

                    let (tx, rx) = mpsc::channel();
                    let reader = pty.clone_reader();
                    std::thread::spawn(move || {
                        loop {
                            let r = reader.read().unwrap();
                            match r {
                                Message::Data(data) => {
                                    if String::from_utf8_lossy(&data).contains(expect) {
                                        tx.send(Ok(())).unwrap();
                                        break;
                                    }
                                }
                                Message::End(_) => {
                                    tx.send(Err(())).unwrap();
                                    break;
                                }
                            }
                            std::thread::sleep(std::time::Duration::from_millis(100));
                        }
                    });
                    rx.recv().unwrap().unwrap();
                };

                write_and_expect("5+4\n\r", "9");
                write_and_expect("let a = 4; a + a\n\r", "8");

                // test size, resize
                assert!(matches!(
                    pty.get_size(),
                    Ok(PtySize {
                        rows: 24,
                        cols: 80,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                ));

                pty.resize(PtySize {
                    rows: 50,
                    cols: 120,
                    pixel_width: 1,
                    pixel_height: 1,
                })
                .unwrap();
                assert!(matches!(
                    pty.get_size(),
                    Ok(PtySize {
                        rows: 50,
                        cols: 120,
                        pixel_width: 1,
                        pixel_height: 1,
                    })
                ));
            }));
        }
        threads.into_iter().for_each(|t| t.join().unwrap());
    }
}

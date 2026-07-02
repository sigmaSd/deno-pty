import { type CommandOptions, getLibrary, type PtySize } from "./ffi.ts";
import {
  decodeCString,
  decodePointerLenData,
  encodeCString,
  encodePointerLenData,
  freeRustData,
  freeRustString,
  readErrorAndFree, // Use the combined read+free for errors
  readPointerFromResultBuffer,
} from "./utils.ts";

// --- Result type for read operations ---
/**
 * Represents the result of a read operation from the PTY.
 */
export type PtyReadResult = {
  /** The data read from the PTY as a string. */
  data: string;
  /** Indicates that data was successfully read and the process is still running. */
  done: boolean;
};

/**
 * Represents a Pseudo-Terminal (PTY) managed via a Rust FFI backend.
 * Provides methods for interacting with the PTY, such as reading output,
 * writing input, resizing, and closing. Also offers stream-based APIs
 * for reading and writing.
 */
export class Pty {
  /** @internal The opaque pointer to the underlying Rust Pty struct. Null if closed. */
  #ptr: Deno.PointerValue | null;
  /** @internal Configurable polling interval for readableStream */
  #pollingIntervalMs = 100;
  #exitCode: number | undefined;

  /** The exit code of the process, if it has exited. */
  get exitCode(): undefined | number {
    return this.#exitCode;
  }

  /**
   * Creates a new Pty instance and spawns the specified command within it.
   * This involves communicating with the Rust FFI layer to create the underlying
   * pseudoterminal and start the child process.
   *
   * @param command - The program path
   * @param options - The command configuration
   * @throws {Error} If the FFI call to create the PTY fails.
   * @throws {Error} If the FFI call succeeds but returns an invalid pointer.
   */
  constructor(command: string, options: CommandOptions = {}) {
    // 1. Encode command using pointer + length (bincode serialization)
    const rustCommand = { cmd: command, ...options };
    const cmdData = encodePointerLenData(rustCommand);
    const cmdDataPtr = Deno.UnsafePointer.of(cmdData); // Get pointer TO the TS buffer containing serialized data

    // 2. Prepare result buffer (for the Pty pointer or error CString pointer)
    // Rust will write the resulting pointer (either *mut Pty or *mut c_char for error) here.
    const resultPtrBuf = new BigUint64Array(1);

    // 3. Call FFI function: pty_create(cmd_ptr, cmd_len, result_ptr_buf) -> status
    const status = getLibrary().symbols.pty_create(
      cmdDataPtr,
      BigInt(cmdData.length),
      resultPtrBuf, // Pass buffer for Rust to write result pointer into
    );

    // 4. Handle result
    if (status === -1) {
      // Error occurred, resultPtrBuf now contains pointer to error CString allocated by Rust
      const errorMsg = readErrorAndFree(getLibrary(), resultPtrBuf);
      throw new Error(`Pty creation failed: ${errorMsg}`);
    }

    // Success (status == 0), resultPtrBuf contains the opaque pointer to the Rust Pty struct
    const ptyPtr = readPointerFromResultBuffer(resultPtrBuf);
    if (!ptyPtr) {
      // This should ideally not happen if status is 0, but robust code checks.
      // It might indicate an internal logic error in the Rust FFI layer.
      throw new Error("Pty creation succeeded but returned a null pointer.");
    }
    this.#ptr = ptyPtr;
  }

  /**
   * Reads pending output from the PTY's pseudoterminal master file descriptor.
   * This operation is non-blocking. If no data is immediately available, it returns
   * an empty string result ({ data: "", done: false }).
   * If the child process associated with the PTY has exited, it returns a result
   * indicating completion ({ done: true, data: "" }).
   *
   * Prefer using `readableStream()` for more ergonomic consumption of output.
   *
   * @returns {PtyReadResult} An object containing the data read (as a string)
   *                         or an indication that the process has finished.
   * @throws {Error} If the Pty has already been closed (`close()` was called).
   * @throws {Error} If the underlying FFI call to `pty_read` fails and returns an error message.
   * @throws {Error} If the FFI call returns an unexpected status code.
   */
  read(): PtyReadResult {
    if (!this.#ptr) throw new Error("Pty is closed.");

    // Prepare buffer for Rust to write the result pointer (data CString* or error CString*)
    const resultPtrBuf = new BigUint64Array(1);
    // Call FFI: pty_read(pty_ptr, result_ptr_buf) -> status
    const status = getLibrary().symbols.pty_read(this.#ptr, resultPtrBuf);

    switch (status) {
      case 0: { // Success, data available (or empty string)
        const dataPtr = readPointerFromResultBuffer(resultPtrBuf);
        if (!dataPtr) {
          // Rust's CString::new("") results in a valid, non-null pointer to a zero-byte string.
          // A null pointer here *after* status 0 might indicate an FFI inconsistency or error.
          // However, returning an empty string might be the safest fallback.
          console.warn("pty_read returned status 0 but a null data pointer.");
          return { data: "", done: false };
        }
        try {
          // Decode the CString pointer received from Rust
          const data = decodeCString(dataPtr);
          return { data, done: false };
        } finally {
          // Free the CString memory allocated by Rust
          freeRustString(getLibrary(), dataPtr);
        }
      }
      case 99: { // Special status code indicating the process has finished
        const dataPtr = readPointerFromResultBuffer(resultPtrBuf);
        if (!dataPtr) {
          console.warn("could not read exit code");
          return { data: "", done: true };
        }
        try {
          const exitCode = decodeCString(dataPtr);
          this.#exitCode = Number.parseInt(exitCode);
          return { data: "", done: true };
        } finally {
          freeRustString(getLibrary(), dataPtr);
        }
      }
      case -1: { // Error occurred
        // resultPtrBuf contains the error CString pointer
        const errorMsg = readErrorAndFree(getLibrary(), resultPtrBuf);
        throw new Error(`Pty read failed: ${errorMsg}`);
      }
      default:
        // Should not happen with the current Rust implementation
        throw new Error(`Pty read returned unexpected status: ${status}`);
    }
  }

  /**
   * Reads pending output from the PTY as RAW BYTES, without UTF-8 decoding.
   *
   * Unlike {@linkcode Pty.read}, chunk boundaries that split a multi-byte
   * UTF-8 codepoint are the caller's concern — decode with a streaming
   * decoder (`new TextDecoder(undefined, { fatal: false })` +
   * `decode(bytes, { stream: true })`) or hand the bytes to a consumer that
   * decodes itself (e.g. xterm.js `Terminal.write(Uint8Array)`). Interior
   * NUL bytes in the stream are passed through instead of erroring.
   *
   * Non-blocking: returns `{ data: empty, done: false }` when nothing is
   * pending.
   *
   * @returns The bytes read (empty when none) and whether the process ended.
   * @throws {Error} If the Pty has already been closed (`close()` was called).
   * @throws {Error} If the underlying FFI call fails.
   */
  readBytes(): { data: Uint8Array; done: boolean } {
    if (!this.#ptr) throw new Error("Pty is closed.");

    // Two usize slots: [data_ptr, len] | [exit_code, 0] | [err_cstr_ptr, 0]
    const out = new BigUint64Array(2);
    const status = getLibrary().symbols.pty_read_bytes(this.#ptr, out);

    switch (status) {
      case 0: {
        const len = Number(out[1]);
        const ptr = Deno.UnsafePointer.create(out[0]);
        if (!ptr || len === 0) {
          return { data: new Uint8Array(0), done: false };
        }
        try {
          const data = new Uint8Array(len);
          new Deno.UnsafePointerView(ptr).copyInto(data);
          return { data, done: false };
        } finally {
          getLibrary().symbols.free_data(ptr, BigInt(len));
        }
      }
      case 99: {
        this.#exitCode = Number(out[0]);
        return { data: new Uint8Array(0), done: true };
      }
      case -1: {
        const errPtrBuf = new BigUint64Array([out[0]]);
        const errorMsg = readErrorAndFree(getLibrary(), errPtrBuf);
        throw new Error(`Pty readBytes failed: ${errorMsg}`);
      }
      default:
        throw new Error(`Pty readBytes returned unexpected status: ${status}`);
    }
  }

  /**
   * Writes the given data (as a string) to the PTY's input (master file descriptor).
   * This data is typically forwarded to the standard input of the child process.
   * The string is encoded as a null-terminated C string before being passed to the FFI.
   *
   * Prefer using `writableStream()` for potentially easier integration with other streams.
   *
   * @param data - The string data to write to the PTY.
   * @throws {Error} If the Pty has already been closed (`close()` was called).
   * @throws {Error} If the underlying FFI call to `pty_write` fails and returns an error message.
   */
  write(data: string): void {
    if (!this.#ptr) throw new Error("Pty is closed.");

    // Encode data as CString (null-terminated UTF-8 byte array)
    const dataCStr = encodeCString(data);

    // Prepare buffer for Rust to potentially write an error CString pointer
    const errorPtrBuf = new BigUint64Array(1);

    // Call FFI: pty_write(pty_ptr, data_cstr_ptr, error_ptr_buf) -> status
    const status = getLibrary().symbols.pty_write(
      this.#ptr,
      dataCStr, // Pass pointer to the null-terminated CString data
      errorPtrBuf,
    );

    if (status === -1) {
      const errorMsg = readErrorAndFree(getLibrary(), errorPtrBuf);
      throw new Error(`Pty write failed: ${errorMsg}`);
    }
    // Success (status == 0), nothing to return or clean up on the TS side
  }

  /**
   * Retrieves the current size (rows and columns) of the PTY terminal.
   * This involves an FFI call that returns the size information serialized
   * into a raw byte buffer (pointer + length).
   *
   * @returns {PtySize} An object containing the number of rows and columns.
   * @throws {Error} If the Pty has already been closed (`close()` was called).
   * @throws {Error} If the underlying FFI call to `pty_get_size` fails and returns an error message.
   * @throws {Error} If the FFI call succeeds but returns an invalid data pointer.
   */
  getSize(): PtySize {
    if (!this.#ptr) throw new Error("Pty is closed.");

    // Prepare buffers for Rust to write results:
    const resultDataPtrBuf = new BigUint64Array(1); // For *mut u8 (pointer to serialized PtySize)
    const resultLenBuf = new BigUint64Array(1); // For usize (length of serialized data)
    const errorPtrBuf = new BigUint64Array(1); // For *mut c_char (error CString pointer)

    // Call FFI: pty_get_size(pty_ptr, result_data_ptr_buf, result_len_buf, error_ptr_buf) -> status
    const status = getLibrary().symbols.pty_get_size(
      this.#ptr,
      resultDataPtrBuf,
      resultLenBuf,
      errorPtrBuf,
    );

    if (status === -1) {
      const errorMsg = readErrorAndFree(getLibrary(), errorPtrBuf);
      throw new Error(`Pty getSize failed: ${errorMsg}`);
    }

    // Success (status == 0), read pointer and length of the serialized data
    const dataPtr = readPointerFromResultBuffer(resultDataPtrBuf);
    const len = Number(resultLenBuf[0]); // usize fits safely in JS number for typical lengths

    if (!dataPtr) {
      // Should not happen on success according to the Rust contract, but check defensively.
      throw new Error("Pty getSize succeeded but returned null data pointer.");
    }

    try {
      // Decode the raw byte data (allocated by Rust) into a PtySize object
      const size = decodePointerLenData<PtySize>(dataPtr, len);
      return size;
    } finally {
      // Free the raw data buffer allocated by Rust
      freeRustData(getLibrary(), dataPtr, len);
    }
  }

  /**
   * Resizes the PTY terminal to the specified dimensions (rows and columns).
   * This typically sends a `SIGWINCH` signal to the foreground process group
   * in the PTY session on Unix-like systems. The size information is serialized
   * and passed to the FFI layer.
   *
   * @param size - An object containing the desired number of rows and columns.
   * @throws {Error} If the Pty has already been closed (`close()` was called).
   * @throws {Error} If the underlying FFI call to `pty_resize` fails and returns an error message.
   */
  resize(size: PtySize): void {
    if (!this.#ptr) throw new Error("Pty is closed.");
    size.pixel_height ??= 0;
    size.pixel_width ??= 0;

    // Encode size object into raw bytes using pointer + length (bincode serialization)
    const sizeData = encodePointerLenData(size);
    const sizeDataPtr = Deno.UnsafePointer.of(sizeData); // Get pointer TO the TS buffer

    // Prepare buffer for Rust to potentially write an error CString pointer
    const errorPtrBuf = new BigUint64Array(1);

    // Call FFI: pty_resize(pty_ptr, size_data_ptr, size_data_len, error_ptr_buf) -> status
    const status = getLibrary().symbols.pty_resize(
      this.#ptr,
      sizeDataPtr,
      BigInt(sizeData.length),
      errorPtrBuf,
    );

    if (status === -1) {
      const errorMsg = readErrorAndFree(getLibrary(), errorPtrBuf);
      throw new Error(`Pty resize failed: ${errorMsg}`);
    }
    // Success (status == 0)
  }

  /**
   * Closes the PTY master file descriptor and requests the Rust side to clean up
   * resources associated with this PTY instance. This includes dropping the Rust `Pty`
   * struct (which typically attempts to terminate the child process).
   *
   * After calling `close()`, the `Pty` object should be considered unusable, and
   * further method calls will throw an error (due to `#ptr` being null). It's safe
   * to call `close()` multiple times; subsequent calls after the first will have no effect.
   *
   * Note: This does *not* close the global FFI library instance (`LIBRARY`).
   * The library remains loaded until the Deno process exits.
   */
  close(): void {
    if (this.#ptr) {
      const ptrToClose = this.#ptr; // Capture ptr before nulling
      this.#ptr = null; // Mark as closed immediately to prevent race conditions

      try {
        // Call the FFI function to drop the Pty struct on the Rust side
        // pty_close(pty_ptr) -> void (no return value, errors are exceptional)
        getLibrary().symbols.pty_close(ptrToClose);
      } catch (e) {
        // Log error during close but keep marked as closed locally.
        // An error here might mean the Rust side panicked during drop.
        console.error("Error during pty_close FFI call:", e);
        // Even if close failed, #ptr is already null, preventing further use.
      }
      // DO NOT close the global LIBRARY here. It should persist for the application lifetime.
      // LIBRARY.close(); // Incorrect: Closes the library for all potential Pty instances.
    }
    // If this.#ptr is already null, do nothing (idempotent close).
  }

  /**
   * Returns a `ReadableStream<string>` that yields data read from the PTY.
   * The stream automatically handles polling the underlying PTY and closes
   * when the PTY process exits or errors when a read error occurs.
   *
   * Note: It's recommended to consume the stream promptly to avoid excessive
   * buffering within the stream controller.
   *
   * @returns {ReadableStream<string>} A readable stream of the PTY output.
   * @throws {Error} If the Pty is already closed when the stream is created (the stream will error immediately).
   */
  get readable(): ReadableStream<string> {
    if (!this.#ptr) {
      return new ReadableStream({
        start(controller) {
          controller.error(new Error("Pty is closed."));
        },
      });
    }

    // Keep a reference to the Pty instance for the stream source
    // deno-lint-ignore no-this-alias
    const ptyInstance = this;
    let isCancelled = false; // Flag for cancellation
    let currentTimeoutId: ReturnType<typeof setTimeout> | undefined = undefined; // <--- Store timer ID

    // Helper to clear the timeout reliably
    function clearTimeoutIfActive() {
      if (currentTimeoutId !== undefined) {
        clearTimeout(currentTimeoutId);
        currentTimeoutId = undefined;
      }
    }

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          while (!isCancelled) { // Check cancellation flag
            try {
              // Check pointer validity before reading (in case close() was called)
              if (!ptyInstance.#ptr) {
                if (!isCancelled) { // Avoid closing twice if cancelled already
                  controller.close();
                }
                clearTimeoutIfActive();
                break; // Exit loop if Pty closed externally
              }

              const { data, done } = ptyInstance.read();

              // Always pause after read attempt
              // IMPORTANT: this needs to be done immmediatly afer read before enqueueuing data
              // This gives the event loop a better chance to process other tasks
              await new Promise<void>((resolve) => { // Use void for clarity
                // Ensure previous timer is cleared before setting new one (shouldn't be necessary but safe)
                clearTimeoutIfActive();
                currentTimeoutId = setTimeout(() => {
                  currentTimeoutId = undefined; // Clear ID when timer fires naturally
                  resolve();
                }, ptyInstance.#pollingIntervalMs);
              });

              if (done) {
                if (!isCancelled) controller.close();
                // No need to clear timer here, await already finished
                break; // Exit loop on graceful process end
              }

              // Only enqueue if there's actual data
              if (data.length > 0) {
                controller.enqueue(data);
              }
            } catch (e) {
              if (!isCancelled) controller.error(e); // Signal error
              clearTimeoutIfActive();
              break; // Exit loop on error
            }
          }
          // Optional: Log exit reason
          // console.log(`[PTY Stream] Exiting polling loop. Cancelled: ${isCancelled}`);
        })();
      },

      cancel() {
        // console.log("[PTY Stream] Stream cancelled:", reason);
        isCancelled = true; // Set cancellation flag
        clearTimeoutIfActive();
      },
    });
  }
  /**
   * Returns a WritableStream<string> that writes data to the PTY's input.
   * Handles encoding the string data before passing it to the underlying write method.
   *
   * @returns {WritableStream<string>} A writable stream for the PTY input.
   * @throws {Error} If the Pty is already closed when the stream is created (the stream will error immediately).
   */
  get writable(): WritableStream<string> {
    if (!this.#ptr) {
      return new WritableStream({
        start(controller) {
          controller.error(new Error("Pty is closed."));
        },
        write() { // Also error on write if closed at creation
          throw new Error("Pty is closed.");
        },
      });
    }
    // deno-lint-ignore no-this-alias
    const ptyInstance = this;
    return new WritableStream<string>({
      write(chunk, controller) {
        // Check if Pty is still valid *before* writing
        if (!ptyInstance.#ptr) {
          const err = new Error("Pty is closed.");
          controller.error(err); // Signal error to the writer
          throw err; // Also throw to stop potential pipelines
        }
        try {
          ptyInstance.write(chunk); // Use the low-level write
        } catch (e) {
          controller.error(e); // Signal error to the writer
          throw e; // Re-throw error
        }
      },
      close() {
        // Closing the writer doesn't necessarily mean we should close the Pty itself.
        // It just means no more data will be written via this stream instance.
        // console.log("[PTY Writable] Stream closed."); // Optional debug log
      },
      abort(_reason) {
        // Similar to close, aborting the writer doesn't automatically close the Pty.
        // console.log("[PTY Writable] Stream aborted:", reason); // Optional debug log
      },
    } /* new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 16 }) */); // Optional: Add queuing strategy if needed
  }

  /**
   * Sets the interval for polling the PTY output when using `readableStream()`.
   * Lower values increase responsiveness but may use slightly more CPU.
   * Affects streams created *after* this call.
   * @param ms Polling interval in milliseconds. Defaults to 100. Must be positive.
   */
  setPollingInterval(ms: number): void {
    if (ms > 0) {
      this.#pollingIntervalMs = ms;
    } else {
      console.warn("Polling interval must be positive.");
    }
  }

  /**
   * Gets the current polling interval used by `readableStream()`.
   * @returns Polling interval in milliseconds.
   */
  getPollingInterval(): number {
    return this.#pollingIntervalMs;
  }
}

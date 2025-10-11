import * as plug from "@denosaurs/plug";
import metadata from "../deno.json" with { type: "json" };

/**
 * Represents the options for creating a new pseudoterminal (pty) process.
 */
export interface CommandOptions {
  /** The arguments for the command. */
  args?: string[];
  /** The environment variables for the command. */
  env?: Record<string, string>;
  /** The working directory for the command. defaults to the current working directory. */
  cwd?: string;
}

/**
 * Represents the size of the visible display area in the pty.
 */
export interface PtySize {
  /** The number of lines of text. */
  rows: number;
  /** The number of columns of text. */
  cols: number;
  /** The width of a cell in pixels. Note that some systems may ignore this value. */
  pixel_width?: number;
  /** The height of a cell in pixels. Note that some systems may ignore this value. */
  pixel_height?: number;
}

const SYMBOLS = {
  // Input command: Pointer + Length. Output: Pty pointer or Error CString pointer
  pty_create: {
    parameters: ["pointer", "usize", "buffer"], // cmd_ptr, cmd_len, result_usize_ptr
    result: "i8", // Status code (0: success, -1: error)
  },
  // Input: Pty Pointer. Output: Data CString pointer or Error CString pointer
  pty_read: {
    parameters: ["pointer", "buffer"], // pty_ptr, result_usize_ptr
    result: "i8", // Status code (0: data, 99: end, -1: error)
  },
  // Input: Pty Pointer, Data CString pointer. Output: Error CString pointer
  pty_write: {
    parameters: ["pointer", "buffer", "buffer"], // pty_ptr, data_cstr_ptr, error_usize_ptr
    result: "i8", // Status code (0: success, -1: error)
  },
  // Input: Pty Pointer. Output: Data pointer+length or Error CString pointer
  pty_get_size: {
    parameters: ["pointer", "buffer", "buffer", "buffer"], // pty_ptr, result_data_ptr_ptr (*mut *mut u8), result_len_ptr (*mut usize), error_usize_ptr
    result: "i8", // Status code (0: success, -1: error)
  },
  // Input: Pty Pointer, Size data pointer+length. Output: Error CString pointer
  pty_resize: {
    parameters: ["pointer", "pointer", "usize", "buffer"], // pty_ptr, size_ptr, size_len, error_usize_ptr
    result: "i8", // Status code (0: success, -1: error)
  },
  // Input: Pty Pointer. Consumes the pointer.
  pty_close: {
    parameters: ["pointer"], // pty_ptr
    result: "void",
  },
  // --- Memory Management Functions ---
  // Input: CString pointer allocated by Rust. Frees it.
  free_string: {
    parameters: ["pointer"], // ptr_to_free
    result: "void",
  },
  // Input: Data pointer + length allocated by Rust. Frees it.
  free_data: {
    parameters: ["pointer", "usize"], // ptr_to_free, len
    result: "void",
  },
} satisfies Deno.ForeignLibraryInterface;

// --- Type alias for the dynamic library type ---
export type PtyLib = Deno.DynamicLibrary<typeof SYMBOLS>;

let LIBRARY: PtyLib | undefined = undefined;

/**
 * Gets the instantiated library instance.
 * @throws {Error} If the library has not been instantiated yet.
 * @returns {PtyLib} The instantiated library.
 */
export function getLibrary(): PtyLib {
  if (!LIBRARY) {
    throw new Error("Library not instantiated. Call instantiate() first.");
  }
  return LIBRARY;
}

/**
 * Loads the native Pty library.
 * @param {string} [libPath] - Optional path to the library file otherwise it will fetch released builds from GitHub.
 * @throws {Error} If the library fails to load.
 */
export async function instantiate(libPath?: string): Promise<void> {
  if (libPath) {
    LIBRARY = Deno.dlopen(libPath, SYMBOLS);
    return;
  }

  const name = "pty";
  const url =
    `https://github.com/sigmaSd/deno-pty-ffi/releases/download/${metadata.version}`;

  LIBRARY = await plug.dlopen(
    {
      name,
      url: Deno.env.get("RUST_LIB_PATH") || url,
      // reload cache if developping locally
      cache: Deno.env.get("RUST_LIB_PATH") ? "reloadAll" : "use",
      suffixes: {
        linux: {
          aarch64: "_aarch64",
          x86_64: "_x86_64",
        },
        darwin: {
          aarch64: "_arm64",
          x86_64: "_x86_64",
        },
      },
    },
    SYMBOLS,
  );
}

/**
 * Utility function to get the library name depending on the OS.
 * @returns {string} The name of the library.
 */
export function libName(): string {
  switch (Deno.build.os) {
    case "linux":
      return `libpty_${Deno.build.arch}.so`;
    case "darwin":
      return `libpty_${
        Deno.build.arch === "x86_64" ? "x86_64" : "arm64"
      }.dylib`;
    case "windows":
      return "pty.dll";
    default:
      throw new Error(`Unsupported OS: ${Deno.build.os}`);
  }
}

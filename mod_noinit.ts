/**
# Deno Pty FFI

deno wrapper over https://docs.rs/portable-pty/latest/portable_pty/ that exposes
a simple interface

The no init module expects the user to initialize the library before using it.

## Usage

```ts
import { Pty, instantiate, libName } from "jsr:@sigma/pty-ffi/noinit";

if (Deno.build.standalone) {
  await instantiate(`${import.meta.dirname}/${libName}`);
} else {
  await instantiate();
}

const pty = new Pty("bash");

// executs ls -la repedetly and shows output
for await (const line of pty.readable) {
  console.log(line);
  pty.write("ls -la\n");
}
```

@module
*/

export { Pty, type PtyReadResult } from "./src/mod.ts";
export { instantiate, libName } from "./src/ffi.ts";
export type { CommandOptions, PtySize } from "./src/ffi.ts";

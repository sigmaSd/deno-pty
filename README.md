# Deno Pty FFI

deno wrapper over https://docs.rs/portable-pty/latest/portable_pty/ that exposes
a simple interface

## Usage

```ts
import { Pty } from "jsr:@sigma/pty-ffi";

const pty = new Pty("bash");

// executs ls -la repedetly and shows output
for await (const line of pty.readable) {
  console.log(line);
  pty.write("ls -la\n");
}
```

### Raw bytes API

For high-throughput consumers (terminals, proxies) read raw bytes and let the
consumer decode. Unlike the string API, interior NUL bytes pass through, and
chunk boundaries splitting a UTF-8 codepoint are the decoder's concern:

```ts
import { Pty } from "jsr:@sigma/pty-ffi";

const pty = new Pty("bash");
const decoder = new TextDecoder();
while (true) {
  const { data, done } = pty.readBytes();
  if (done) break;
  if (data.byteLength) {
    // or: term.write(data) — xterm.js decodes (and handles split codepoints) itself
    console.log(decoder.decode(data, { stream: true }));
  } else {
    await new Promise((r) => setTimeout(r, 10));
  }
}
```

You can also use noinit module, this module expects the user to initialize the
library before using it. (uesful when using deno compile or when wanting to
defer initialization)

```ts
import { instantiate, libName, Pty } from "jsr:@sigma/pty-ffi/noinit";

if (Deno.build.standalone) {
  await instantiate(`${import.meta.dirname}/${libName()}`);
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

You can compile this with

```
deno compile --allow-ffi --include <libPath> myscript.ts
```

or even cross compile

```
deno compile --allow-ffi --include <libExePath> --target x86_64-pc-windows-msvc myscript.ts
```

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

You can also use noinit module, this module expects the user to initialize the
library before using it. (uesful when using deno compile or when wanting to
defer initialization)

```ts
import { instantiate, libName, Pty } from "jsr:@sigma/pty-ffi/noinit";

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

You can compile this with

```
deno compile --allow-ffi --include <libPath> myscript.ts
```

or even cross compile

```
deno compile --allow-ffi --include <libExePath> --target x86_64-pc-windows-msvc myscript.ts
```

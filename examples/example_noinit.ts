import { instantiate, libName, Pty } from "@sigma/pty-ffi/noinit";

if (Deno.build.standalone) {
  await instantiate(`${import.meta.dirname}/${libName}`);
} else {
  await instantiate();
}

const pty = new Pty("ls");
for await (const d of pty.readable) {
  console.log(d);
}

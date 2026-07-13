// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@0.225.3";
import { delay } from "jsr:@std/async@0.224.0";
import { Pty } from "../mod.ts";

Deno.test("exitCode", async () => {
  {
    const pty = new Pty("ls", {});

    assertEquals(pty.exitCode, undefined);
    for await (const _data of pty.readable) {
      // stuff
    }
    assertEquals(pty.exitCode, 0);

    pty.close();
  }
  {
    const pty = new Pty("ls", { args: ["--incorrect-flag"] });

    assertEquals(pty.exitCode, undefined);
    for await (const _data of pty.readable) {
      // stuff
    }
    assertEquals(pty.exitCode, Deno.build.os === "darwin" ? 1 : 2);

    pty.close();
  }
});

Deno.test("smoke", async () => {
  async function write_and_expect(pty: Pty, toWrite: string, expect: string) {
    pty.write(toWrite);

    let success = false;
    while (true) {
      const { data, done } = pty.read();
      if (done) break;
      if (data?.includes(expect)) {
        success = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert(success);
  }
  const pty = new Pty("deno", {
    args: ["repl"],
    env: { NO_COLOR: "1" },
  });

  // read header
  pty.read();

  await write_and_expect(pty, "5+4\n\r", "9");
  await write_and_expect(pty, "let a = 4; a + a\n\r", "8");

  // test size, resize
  assertEquals(pty.getSize(), {
    rows: 24,
    cols: 80,
    pixel_height: 0,
    pixel_width: 0,
  });

  // close the first pty
  // we should still create other ptys
  pty.close();
});

Deno.test("getSize/resize", () => {
  const pty = new Pty(
    Deno.build.os === "windows" ? "cmd" : "echo", // Simple command
    {
      args: ["hello"],
    },
  );

  pty.resize({
    rows: 50,
    cols: 120,
    pixel_height: 1,
    pixel_width: 1,
  });
  const size = pty.getSize();
  // Check returned size, accounting for potential defaults applied
  assertEquals(size.rows, 50);
  assertEquals(size.cols, 120);
  assertEquals(size.pixel_height, 1);
  assertEquals(size.pixel_width, 1);

  pty.close();
});

Deno.test("spawn size", () => {
  // The pty opens at the requested size — the child never observes the
  // default 80x24 grid, so there is no spawn-then-resize race.
  const pty = new Pty(
    Deno.build.os === "windows" ? "cmd" : "echo",
    {
      args: ["hello"],
      size: { rows: 33, cols: 61 },
    },
  );
  const size = pty.getSize();
  assertEquals(size.rows, 33);
  assertEquals(size.cols, 61);
  pty.close();

  // Without a size the default grid stays 80x24.
  const def = new Pty(
    Deno.build.os === "windows" ? "cmd" : "echo",
    { args: ["hello"] },
  );
  const defSize = def.getSize();
  assertEquals(defSize.rows, 24);
  assertEquals(defSize.cols, 80);
  def.close();
});

Deno.test("with cwd set", async () => {
  const tmpDir = await Deno.makeTempDir();
  const testFileName = "pty_cwd_test_file.txt";
  await Deno.writeTextFile(
    `${tmpDir}/${testFileName}`,
    "Test content",
  );

  const cmd = Deno.build.os === "windows" ? "cmd" : "ls";
  const args = Deno.build.os === "windows"
    ? ["/c", `dir /b ${testFileName}`] // /b for bare format
    : [testFileName];

  const pty = new Pty(cmd, {
    args: args,
    cwd: tmpDir,
  });

  let output = "";
  try {
    for await (const data of pty.readable) {
      output += data;
    }
    assertStringIncludes(output.trim(), testFileName);
  } finally {
    pty.close();
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("multibytes chars work correctly", async () => {
  const testString = "日本語你好世界";
  const pty = new Pty("echo", {
    args: [testString],
  });

  let success = false;
  let accumulatedData = "";
  try {
    for await (const data of pty.readable) {
      accumulatedData += data;
      // Trim potential trailing newline from echo
      if (accumulatedData.trim().includes(testString)) {
        success = true;
        break;
      }
    }
    if (!success && accumulatedData.trim().includes(testString)) {
      success = true;
    }
  } finally {
    pty.close();
  }
  assert(
    success,
    `Multibyte string "${testString}" not found in output: "${accumulatedData}"`,
  );
});

// --- New Stream API Tests ---

Deno.test("readableStream basic", async () => {
  const line1 = "Hello from PTY stream!";
  const line2 = "Second line.";
  const pty = new Pty(Deno.build.os === "windows" ? "cmd" : "bash", {
    args: Deno.build.os === "windows"
      ? ["/c", `echo ${line1} && ping -n 2 127.0.0.1>nul && echo ${line2}`]
      : ["-c", `echo "${line1}"; sleep 0.1; echo "${line2}"`],
  });

  let combinedOutput = "";
  const chunks: string[] = [];
  try {
    for await (const data of pty.readable) {
      chunks.push(data);
      combinedOutput += data;
    }
  } finally {
    pty.close();
  }

  assert(chunks.length > 0, "Stream should have received at least one chunk");
  assertStringIncludes(combinedOutput, line1);
  assertStringIncludes(combinedOutput, line2);
});

Deno.test("readableStream handles process exit", async () => {
  const pty = new Pty("echo", { args: ["Exit Test"] });
  let streamEnded = false;
  try {
    for await (const _data of pty.readable) { /* consume */ }
    streamEnded = true;
  } finally {
    pty.close();
  }
  assert(
    streamEnded,
    "ReadableStream should close when the PTY process exits.",
  );
});

// --- UPDATED TEST ---
Deno.test("readableloses gracefully if pty closed during read", async () => {
  const pty = new Pty("sleep", { args: ["5"] }); // Long running command
  const stream = pty.readable;
  const reader = stream.getReader();

  // Start a read, but don't necessarily wait for it here
  const readPromise = reader.read();

  // Give a moment for polling to potentially start
  await delay(50);

  // Close the pty while the stream is active
  pty.close();

  try {
    // Now wait for the outstanding read or subsequent reads.
    // It should eventually resolve with done: true because the pty is closed.
    let result = await readPromise;
    while (!result.done) {
      // If the first read got data before close took effect,
      // keep reading until done is true.
      result = await reader.read();
    }
    // Assert that the stream eventually signals done
    assertEquals(
      result,
      { value: undefined, done: true },
      "Stream should end with done:true after pty is closed",
    );
  } catch (e) {
    // With the src/mod.ts change, this catch should not be hit.
    assert(false, `Stream unexpectedly errored after pty close: ${e}`);
  } finally {
    // Ensure reader is cancelled/released, ignoring errors if already closed.
    await reader.cancel().catch(() => {});
  }
});

Deno.test("writableStream basic", async () => {
  const cmd = Deno.build.os === "windows" ? "findstr" : "cat";
  const args = Deno.build.os === "windows" ? ["/n", "$"] : [];

  const pty = new Pty(cmd, { args: args });

  const input1 = "Line one via writableStream\n";
  const input2 = "Line two\n";
  let receivedOutput = "";
  let readerFinished = false;

  try {
    const readerPromise = (async () => {
      try {
        for await (const data of pty.readable) {
          receivedOutput += data;
        }
        readerFinished = true;
      } catch (e) {
        // Should not error in this test's flow
        console.error("Reader stream errored unexpectedly:", e);
        readerFinished = false; // Mark as failed
      }
    })();

    const writer = pty.writable.getWriter();
    await writer.write(input1);
    await delay(50);
    await writer.write(input2);
    await delay(50);
    await writer.close();

    await delay(100); // Allow final echoes
    pty.close(); // Terminate cat/findstr

    await readerPromise;
  } finally {
    // Ensure closed (idempotent)
    try {
      pty.close();
    } catch { /* ignore */ }
  }

  assert(readerFinished, "Reader stream should have finished.");
  assertStringIncludes(receivedOutput, "Line one");
  assertStringIncludes(receivedOutput, "Line two");
});

Deno.test("writableStream errors if pty closed during write", async () => {
  const pty = new Pty("sleep", { args: ["5"] });
  const stream = pty.writable;
  const writer = stream.getWriter();

  await writer.ready;
  pty.close();

  await assertRejects(
    () => writer.write("data after close"),
    Error,
    "Pty is closed.",
  );

  await writer.abort().catch(() => {});
});

Deno.test("polling interval getter/setter", () => {
  const pty = new Pty("echo", { args: ["test"] });
  try {
    assertEquals(pty.getPollingInterval(), 100); // default value
    pty.setPollingInterval(100);
    assertEquals(pty.getPollingInterval(), 100);
    pty.setPollingInterval(5);
    assertEquals(pty.getPollingInterval(), 5);
    // Test invalid values
    pty.setPollingInterval(-10);
    assertEquals(pty.getPollingInterval(), 5); // Should not change
    pty.setPollingInterval(0);
    assertEquals(pty.getPollingInterval(), 5); // Should not change
  } finally {
    pty.close();
  }
});

Deno.test("methods throw after close", () => {
  const pty = new Pty("echo", { args: ["hello"] });
  pty.close();

  assertThrows(() => pty.read(), Error, "Pty is closed.");
  assertThrows(() => pty.write("test"), Error, "Pty is closed.");
  assertThrows(() => pty.getSize(), Error, "Pty is closed.");
  assertThrows(
    () => pty.resize({ rows: 1, cols: 1 }),
    Error,
    "Pty is closed.",
  );

  // Reading from a stream created *after* close should also end immediately.
  const postCloseStream = pty.readable;
  const reader = postCloseStream.getReader();
  assertRejects(() => reader.read(), Error, "Pty is closed.");

  // Writing to a stream created *after* close should reject.
  const postCloseWritable = pty.writable;
  const writer = postCloseWritable.getWriter();
  assertRejects(() => writer.write("test"), Error, "Pty is closed.");

  pty.close(); // Idempotent close is safe
});

Deno.test("default cwd is current dir", async () => {
  // Determine the command and arguments based on the OS
  const command = Deno.build.os === "windows" ? "cmd" : "pwd";
  // On Windows, tell 'cmd' to execute 'cd' and then exit ('/c')
  const args = Deno.build.os === "windows" ? ["/c", "cd"] : [];

  const pty = new Pty(command, { args });

  let totalData = "";
  try {
    for await (const data of pty.readable) {
      totalData += data;
    }
  } finally {
    // Ensure pty is closed even if the test fails
    pty.close();
  }

  const actualOutput = totalData.trim(); // Trim whitespace/newlines
  const expectedCwd = Deno.cwd();

  // Compare case-insensitively for Windows paths.
  if (Deno.build.os === "windows") {
    assertStringIncludes(
      actualOutput.toLowerCase(),
      expectedCwd.toLowerCase(),
      `Expected output "${actualOutput}" to include "${expectedCwd}" (case-insensitive)`,
    );
  } else {
    assertStringIncludes(
      actualOutput,
      expectedCwd,
      `Expected output "${actualOutput}" to include "${expectedCwd}"`,
    );
  }
});

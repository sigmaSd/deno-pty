// full version at https://github.com/sigmaSd/Minimize-Deno
import { Pty } from "@sigma/pty-ffi";

if (Deno.args.length === 0) throw new Error("no program provided");

const pty = new Pty(Deno.execPath(), {
  args: ["run", ...Deno.args],
  env: { NO_COLOR: "1" },
});

type Permission = "read" | "write" | "net" | "env";
const permissions: Record<Permission, string[]> = {
  read: [],
  write: [],
  net: [],
  env: [],
};

Deno.addSignalListener("SIGINT", () => {
  console.log("\nPermissions:");
  console.log(permissions);
  console.log("Command:");
  console.log(
    `deno run ${permissions.read ? `--allow-read=${permissions.read}` : ""} ${
      permissions.write ? `--allow-write=${permissions.write}` : ""
    } ${permissions.net ? `--allow-net=${permissions.net}` : ""} ${
      permissions.env ? `--allow-env=${permissions.env}` : ""
    }`,
  );
  Deno.exit();
});

for await (const line of pty.readable) {
  if (line.includes("Granted") && line.includes("access")) {
    const line_split = line.split(/\s+/);
    const mark = line_split.indexOf("access");
    const permission_type = line_split[mark - 1] as Permission;
    let permission = line_split[mark + 2].slice(1, -2);

    switch (permission) {
      case "CWD":
        permission = Deno.cwd();
        break;
    }

    console.log(permission_type, permission);
    permissions[permission_type].push(permission);
  }

  // wait a bit for read data
  await new Promise((r) => setTimeout(r, 100));
  if (line.includes("Allow?")) {
    pty.write("y\n");
  }
}

pty.close();

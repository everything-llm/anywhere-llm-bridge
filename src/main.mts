#!/usr/bin/env node
// anywherellm-bridge: `install`, `uninstall` and `health` set up the bridge as a service
// (install.mts); `serve` runs it; `pair` prints the link a phone connects with; `settings` prints
// the settings in use.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { Asks } from "./asks.mts";
import { invalid } from "./errors.mts";
import { Upstream } from "./upstream.mts";
import defaultAllow from "../default-allow.txt";
import { defaultList } from "./allow.mts";
import { health, install, uninstall, type Ctx } from "./install.mts";
import { developerKey, pairingLink } from "./pair.mts";
import { createServer } from "./server.mts";
import { fileFor, loadSettings, shown } from "./settings.mts";

const USAGE = `usage: anywherellm-bridge <command>

  install [--storage DIR]        point the bridge at AnythingLLM's storage (its .env holds the
          [--no-start]           password) and start it under your service manager
          [--service systemd|launchd|windows|foreground|auto]
  uninstall                      stop the bridge; its settings stay
  health                         check it all; exit 1 when a check fails
  serve                          run the bridge
  pair [--url U] [--bridge U] [--apps U]
                                 print the link AnywhereLLM Lite connects with (it holds the key)
  settings                       print the settings in use

The storage is AnythingLLM Desktop's when there is one; for Docker, the folder mounted at
/app/server/storage.
`;

const ctx: Ctx = {
  home: os.homedir(),
  env: process.env,
  platform: process.platform,
  print: console.log,
  command: [process.execPath, fs.realpathSync(process.argv[1]), "serve"],
  defaultAllow: defaultList(defaultAllow),
};

const OPTIONS: Record<string, ParseArgsConfig["options"]> = {
  install: { storage: { type: "string" }, "no-start": { type: "boolean" }, service: { type: "string" } },
  pair: { url: { type: "string" }, bridge: { type: "string" }, apps: { type: "string" } },
};

async function main(argv: string[]): Promise<number | void> {
  const [command, ...rest] = argv;
  const values = parseArgs({ args: rest, options: OPTIONS[command] ?? {} }).values as Record<string, string | boolean | undefined>;
  const text = (name: string) => values[name] as string | undefined;
  switch (command) {
    case "serve": {
      const settings = loadSettings(ctx);
      const asks = settings.storage ? new Asks(path.join(settings.storage, "fence-lean")) : null;
      const server = createServer({ rules: settings.allow, upstream: Upstream.of(settings), asks, log: console.error });
      server.on("error", (e) => {
        console.error(`anywherellm-bridge: ${e.message}`);
        process.exit(1);
      });
      server.listen(settings.port, "127.0.0.1", () => console.error(`the bridge on :${settings.port}, passing ${settings.allow.length} routes`));
      for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
      return; // runs until stopped
    }
    case "install":
      await install(ctx, { storage: text("storage"), start: !values["no-start"], service: text("service") });
      return 0;
    case "uninstall":
      uninstall(ctx);
      return 0;
    case "health":
      return (await health(ctx)) ? 0 : 1;
    case "pair": {
      const settings = loadSettings(ctx);
      const address = text("url") || settings.anythingllmPublicUrl;
      if (!address) throw invalid("no address for AnythingLLM: set ANYTHINGLLM_PUBLIC_URL or PUBLIC_HOST in the settings, or pass --url");
      const key = await developerKey(Upstream.of(settings));
      console.error(`Open this in AnywhereLLM Lite to connect to ${address}. It holds the key:`);
      console.log(pairingLink(address, key, text("bridge") || settings.publicUrl, text("apps") || settings.appsUrl));
      return 0;
    }
    case "settings":
      console.log(`# from ${fileFor(ctx)} and the environment`);
      for (const [key, value] of Object.entries(shown(loadSettings(ctx)))) console.log(`${key}=${value}`);
      return 0;
    default:
      console.error(USAGE);
      return command ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exit(code);
  },
  (e: unknown) => {
    console.error(`anywherellm-bridge: ${(e as Error).message}`);
    process.exit(1);
  },
);

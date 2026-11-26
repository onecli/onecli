import { run } from "./cli";

// The command's entry: `onecli-browser` is a shim that runs
// `node dist/browser-driver/cli.mjs "$@"`.
run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);

// The animated OneCLI wordmark that opens `pnpm run setup`.
//
// A 2-column white edge sweeps left to right over half-block letters:
// columns behind it wear the brand tone, columns ahead sit in a dark shell —
// the logo is revealed rather than printed. Zero dependencies (raw truecolor
// ANSI), and it degrades to one plain line anywhere animation would be noise:
// no TTY, --yes runs, CI, NO_COLOR, dumb terminals, narrow windows.

const WORDMARK = [
  "                        █  ▀",
  "▄▀▀▄  █▀▀▄  ▄▀▀▄  ▄▀▀▀  █  █",
  "█  █  █  █  █▀▀▀  █     █  █",
  "▀▄▄▀  █  █  ▀▄▄▀  ▀▄▄▄  █  █",
];
const WIDTH = Math.max(...WORDMARK.map((row) => row.length));

const fg = (hex) =>
  `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
const ACCENT = fg("#e6e6e6");
const EDGE = fg("#ffffff");
const SHELL = fg("#3d3d3d");
const RESET = "\x1b[0m";
const FRAME_DELAY_MS = 35;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const renderRow = (row, edge) => {
  let out = "";
  for (let col = 0; col < row.length; col++) {
    const ch = row[col];
    if (ch === " ") out += ch;
    else if (col < edge - 1) out += ACCENT + ch;
    else if (col <= edge) out += EDGE + ch;
    else out += SHELL + ch;
  }
  return out + RESET;
};

const paintFrame = (edge, redraw) => {
  if (redraw) process.stdout.write(`\x1b[${WORDMARK.length}F`);
  for (const row of WORDMARK)
    process.stdout.write(`\x1b[K${renderRow(row, edge)}\n`);
};

/** Animated wordmark; one plain line when animation would be noise. */
export const showBanner = async ({ animate = true } = {}) => {
  const rich =
    animate &&
    process.stdout.isTTY &&
    !process.env.CI &&
    !process.env.NO_COLOR &&
    (process.env.TERM ?? "") !== "dumb" &&
    (process.stdout.columns ?? 80) >= WIDTH + 2;

  console.log();
  if (!rich) {
    console.log("◆ OneCLI");
    console.log();
    return;
  }

  const onSigint = () => {
    process.stdout.write(`${RESET}\x1b[?25h\n`);
    process.exit(130);
  };
  // Prepended: index.mjs registered its own SIGINT→exit(130) first, and the
  // first listener to call process.exit wins — the cursor restore must run
  // before that.
  process.prependOnceListener("SIGINT", onSigint);
  process.stdout.write("\x1b[?25l");
  try {
    paintFrame(-2, false);
    for (let edge = 0; edge <= WIDTH + 2; edge++) {
      await sleep(FRAME_DELAY_MS);
      paintFrame(edge, true);
    }
  } finally {
    process.stdout.write(`${RESET}\x1b[?25h`);
    process.removeListener("SIGINT", onSigint);
  }
  console.log();
};

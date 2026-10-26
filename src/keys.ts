const NAMED: Record<string, string> = {
  enter: "\r",
  return: "\r",
  esc: "\x1b",
  escape: "\x1b",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  backspace: "\x7f",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  delete: "\x1b[3~",
};

/** Encode a key name (`esc`, `ctrl+c`, `shift+tab`, `1`, `y`) into terminal bytes. */
export function encodeKey(name: string): string {
  const key = name.toLowerCase();
  const named = NAMED[key];
  if (named) return named;
  const ctrl = /^ctrl\+([a-z])$/.exec(key);
  if (ctrl?.[1]) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  if ([...name].length === 1) return name;
  throw new Error(`unknown key: ${name}`);
}

export const KEY_NAMES = [...Object.keys(NAMED), "ctrl+<letter>", "<single character>"];

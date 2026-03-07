export function hexToAscii(s: string) {
  return s.replace(/../g, x => String.fromCharCode(parseInt(x, 16)))
}

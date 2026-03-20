export function hexToAscii(s: string) {
  return s.replace(/../g, x => String.fromCharCode(parseInt(x, 16)))
}

const textEncoder = new TextEncoder()

export function textEncode(s: string) {
  return textEncoder.encode(s)
}

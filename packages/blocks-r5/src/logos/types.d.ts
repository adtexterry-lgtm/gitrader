// SPDX-License-Identifier: CPAL-1.0
declare module '*.png' {
  const source: Uint8Array | string
  export default source
}

declare module '*.svg' {
  const source: string
  export default source
}

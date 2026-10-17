/**
 * Escape braces in generated Markdown so mdsvex does not interpret them as
 * Svelte expressions. Fenced code blocks and YAML frontmatter are preserved.
 */
export function escapeSvelteMarkdown(markdown) {
  let fence = null
  let frontmatter = /^---\r?\n/.test(markdown) ? 0 : -1
  return markdown
    .split(/(\r?\n)/)
    .map((part) => {
      if (part === '\n' || part === '\r\n') return part
      if (frontmatter >= 0) {
        frontmatter++
        if (frontmatter > 1 && /^---\s*$/.test(part)) frontmatter = -1
        return part
      }
      const marker = part.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/)
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence.char &&
          marker[1].length >= fence.length &&
          /^\s*$/.test(marker[2])
        ) {
          fence = null
        }
        return part
      }
      if (marker) {
        fence = { char: marker[1][0], length: marker[1].length }
        return part
      }
      return part.replace(/[{}]/g, (token) =>
        token === '{' ? '{String.fromCharCode(123)}' : '{String.fromCharCode(125)}'
      )
    })
    .join('')
}

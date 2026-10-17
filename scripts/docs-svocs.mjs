import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { posix, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { escapeSvelteMarkdown } from './escape-svelte-markdown.mjs'

const root = resolve(import.meta.dirname, '..')
const site = resolve(root, 'website')
const manual = resolve(root, 'docs/content')
const command = process.argv[2] ?? 'check'

function run(file, args, cwd = root) {
  const result = spawnSync(file, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${file} ${args.join(' ')} failed with status ${result.status}`)
}

async function markdownEntries(directory) {
  const entries = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) entries.push(...(await markdownEntries(path)))
    else if (entry.isFile() && path.endsWith('.md')) entries.push(path)
  }
  return entries
}

function routeFor(relativePath) {
  if (relativePath === 'index.md') return '/docs'
  return `/docs/${relativePath.replace(/\/index\.md$/, '').replace(/\.md$/, '')}`
}

async function check() {
  if (!existsSync(resolve(site, 'package.json')))
    throw new Error('SVOCS site is not initialized; run npm run docs:setup')
  const sources = await markdownEntries(manual)
  if (sources.length < 6)
    throw new Error(`Expected at least 6 manual documentation pages, found ${sources.length}`)
  const routes = new Set(
    sources.map((file) => routeFor(relative(manual, file).replaceAll('\\', '/')))
  )
  let links = 0
  for (const file of sources) {
    const name = relative(manual, file).replaceAll('\\', '/')
    const body = await readFile(file, 'utf8')
    if (!/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(body))
      throw new Error(`Missing frontmatter in ${name}`)
    for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
      const href = match[1].split(/[?#]/, 1)[0]
      if (!href.startsWith('/docs/')) continue
      if (!routes.has(href) && href !== '/docs/api/reference')
        throw new Error(`Broken docs link ${name}: ${href}`)
      links++
    }
  }
  console.log(`SVOCS docs source OK: ${sources.length} pages, ${links} internal links`)
}

async function writeNavigation(content) {
  await writeFile(
    resolve(content, '_meta.json'),
    JSON.stringify(
      {
        items: {
          start: { type: 'separator', title: 'Start here', order: 1 },
          index: { title: 'Introduction', order: 2, icon: 'book' },
          guide: { title: 'Guides', order: 3, icon: 'terminal' },
          api: { title: 'API', order: 4, icon: 'package' }
        }
      },
      null,
      2
    ) + '\n'
  )
  await writeFile(
    resolve(content, 'guide/_meta.json'),
    JSON.stringify(
      {
        items: {
          'getting-started': { order: 1 },
          fixtures: { order: 2 },
          actions: { order: 3 },
          rdp: { order: 4 }
        }
      },
      null,
      2
    ) + '\n'
  )
  await writeFile(
    resolve(content, 'api/_meta.json'),
    JSON.stringify(
      {
        items: {
          index: { order: 1, title: 'Overview' },
          reference: { order: 2, title: 'Generated API' }
        }
      },
      null,
      2
    ) + '\n'
  )
}

async function normalizeGeneratedApi(apiDirectory) {
  for (const file of await markdownEntries(apiDirectory)) {
    const docRel = relative(apiDirectory, file).replaceAll('\\', '/')
    let markdown = await readFile(file, 'utf8')
    markdown = markdown.replace(
      /(\]\()([^)]*?\.md)(#[^)]*)?(\))/g,
      (all, prefix, link, fragment = '', close) => {
        if (/^(https?:|\/\/)/.test(link)) return all
        const normalized = posix.normalize(posix.join(posix.dirname(docRel), link))
        if (normalized.startsWith('../')) return all
        const routed = normalized
          .replace(/(^|\/)README\.md$/i, '$1index.md')
          .replace(/(^|\/)index\.md$/i, '')
          .replace(/\.md$/i, '')
        return `${prefix}/docs/api/reference${routed ? '/' + routed.replace(/^\//, '') : ''}${fragment}${close}`
      }
    )
    markdown = markdown.replace(
      /\]\([^)]*LICENSE(?:\.md)?\)/g,
      '](https://github.com/OpenPolyfill/firefox-addon-playwright-harness/blob/main/LICENSE)'
    )
    await writeFile(file, escapeSvelteMarkdown(markdown))
  }
  const readme = resolve(apiDirectory, 'README.md')
  if (existsSync(readme)) {
    await cp(readme, resolve(apiDirectory, 'index.md'))
    await rm(readme)
  }
}

async function prepare() {
  await check()
  const content = resolve(site, 'content')
  await rm(content, { recursive: true, force: true })
  await cp(manual, content, { recursive: true })
  await writeNavigation(content)

  const apiDirectory = resolve(content, 'api/reference')
  const temporary = await mkdtemp(resolve(tmpdir(), 'firefox-addon-harness-typedoc-'))
  try {
    run('npm', [
      'exec',
      '--',
      'typedoc',
      '--plugin',
      'typedoc-plugin-markdown',
      '--entryPoints',
      'src/index.ts',
      '--tsconfig',
      'tsconfig.json',
      '--out',
      temporary
    ])
    const generated = await markdownEntries(temporary)
    if (!generated.length) throw new Error('TypeDoc generated no Markdown pages')
    await rm(apiDirectory, { recursive: true, force: true })
    await cp(temporary, apiDirectory, { recursive: true })
    await normalizeGeneratedApi(apiDirectory)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  console.log('Prepared SVOCS content and generated API reference.')
}

function requireSiteDependencies() {
  if (!existsSync(resolve(site, 'node_modules/.bin/vite'))) {
    throw new Error('SVOCS site dependencies are missing; run npm run docs:setup first')
  }
}

async function setup() {
  if (!existsSync(resolve(site, 'package.json'))) throw new Error('SVOCS site scaffold is missing')
  run('npm', ['install'], root)
  run('npm', ['install'], site)
  await prepare()
}

async function build() {
  requireSiteDependencies()
  await prepare()
  run('npm', ['run', 'build'], site)
  if (!existsSync(resolve(site, 'build')))
    throw new Error('SVOCS build did not create website/build')
}

async function main() {
  if (command === 'check') return check()
  if (command === 'setup') return setup()
  if (command === 'prepare') return prepare()
  if (command === 'build') return build()
  if (command === 'dev' || command === 'preview') {
    requireSiteDependencies()
    await prepare()
    return run('npm', ['run', command], site)
  }
  throw new Error(`Unknown docs command: ${command}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

// Build script: compile TSX to JS using babel + solid preset.
// The @opentui/solid/bun-plugin doesn't work with bun v1.3.x (no registerBunPlugin),
// so we use babel directly.

import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import ts from "@babel/preset-typescript"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs"
import { dirname, relative, resolve } from "path"

const ROOT = resolve(import.meta.dirname, "..")
const DIST = resolve(ROOT, "dist")

function discoverSources(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absPath = resolve(directory, entry.name)

      if (entry.isDirectory()) return discoverSources(absPath)
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) return []

      return [{
        path: relative(ROOT, absPath).replaceAll("\\", "/"),
        hasJSX: entry.name.endsWith(".tsx"),
      }]
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

const SOURCES = discoverSources(resolve(ROOT, "plugins"))

async function compile(filePath, hasJSX) {
  const absPath = resolve(ROOT, filePath)
  const code = readFileSync(absPath, "utf8")

  const presets = hasJSX
    ? [[solid, { moduleName: "@opentui/solid", generate: "universal" }], [ts]]
    : [[ts]]

  const result = await transformAsync(code, {
    filename: absPath,
    configFile: false,
    babelrc: false,
    presets,
  })

  if (!result?.code) throw new Error(`No output for ${filePath}`)

  const outPath = resolve(DIST, filePath.replace(/\.tsx?$/, ".js"))
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, result.code, "utf8")
  console.log(`  ${filePath} → ${outPath}`)
}

console.log("Building prompt-enhancer plugin...\n")

try {
  for (const src of SOURCES) {
    await compile(src.path, src.hasJSX)
  }

  // Create dist/index.js entry point
  const indexPath = resolve(DIST, "index.js")
  writeFileSync(indexPath, `export { default } from "./plugins/prompt-enhancer.js"\n`, "utf8")
  console.log(`  index.js (entry) → ${indexPath}`)

  console.log("\nBuild complete.")
} catch (err) {
  console.error("Build failed:", err.message)
  process.exit(1)
}

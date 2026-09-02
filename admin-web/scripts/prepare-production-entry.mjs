import { readFile, writeFile } from 'node:fs/promises'

const distIndex = new URL('../dist/index.html', import.meta.url)
const functionShell = new URL('../../cloudfunctions/admin/admin-shell.html', import.meta.url)
const shell = await readFile(distIndex, 'utf8')

if (!shell.includes('<div id="app"></div>') || shell.includes('/src/main.js')) {
  throw new Error('Admin production shell is incomplete')
}

await writeFile(functionShell, shell)
await writeFile(distIndex, `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'">
  <meta http-equiv="refresh" content="0;url=https://yuyue-d0gdy87711d685d64-1373613778.ap-shanghai.app.tcloudbase.com/admin">
  <title>正在进入管理后台</title>
</head>
<body><p><a href="https://yuyue-d0gdy87711d685d64-1373613778.ap-shanghai.app.tcloudbase.com/admin">进入管理后台</a></p></body>
</html>
`)

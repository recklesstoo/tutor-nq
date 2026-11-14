const fs = require('fs'), path = require('path');
const src = f => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
let html = src('page.html');
html = html.replace('/*ENGINE*/', () => '\n' + src('engine.js')).replace('/*APP*/', () => '\n' + src('app.js'));
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), html);
fs.writeFileSync(path.join(__dirname, 'index.html'), html);   // la que sirve GitHub Pages
console.log('dist/index.html', html.length, 'bytes');

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const TARGET_DIRS = [join(ROOT, 'src', 'ui')];
const TARGET_FILES = [join(ROOT, 'src', 'main.tsx'), join(ROOT, 'index.html')];
const STYLES_CSS = join(ROOT, 'src', 'ui', 'styles.css');
const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath);
      continue;
    }
    const ext = extname(fullPath);
    if (ext === '.tsx' || ext === '.jsx') {
      TARGET_FILES.push(fullPath);
    }
  }
}

for (const dir of TARGET_DIRS) {
  walk(dir);
}

for (const filePath of TARGET_FILES) {
  const content = readFileSync(filePath, 'utf8');
  const patterns = filePath.endsWith('.html')
    ? [
        { regex: /<style[\s>]/g, label: 'inline <style> block' },
        { regex: /\sstyle=/g, label: 'inline style attribute' },
      ]
    : [
        { regex: /\bstyle\s*=\s*\{\{/g, label: 'JSX style prop' },
      ];

  for (const { regex, label } of patterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const before = content.slice(0, match.index);
      const line = before.split('\n').length;
      violations.push(`${filePath}:${line} -> ${label}`);
    }
  }
}

// Enforce: src/ui/styles.css must express everything via Tailwind.
// No raw CSS declarations allowed inside @layer blocks — only @apply, @media,
// nested at-rules, selectors and braces. The @theme block is exempt because
// its custom property declarations are Tailwind v4 design tokens. Multi-line
// @apply statements are allowed (continuation lines like `hover:foo` look
// like property-value pairs but are Tailwind variants, not raw CSS).
{
  const content = readFileSync(STYLES_CSS, 'utf8');
  const lines = content.split('\n');
  const stack = [];
  let currentBlock = null;
  let applyOpen = false;

  const cssDeclarationRegex = /^[a-zA-Z-][\w-]*\s*:/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

    // Continuation of a multi-line @apply — skip until we see the terminator.
    if (applyOpen) {
      if (trimmed.includes(';')) applyOpen = false;
      continue;
    }

    // Track @theme / @layer block entries so we know if we're inside an
    // exempt block or a Tailwind layer where raw CSS must be rejected.
    const atLayerMatch = trimmed.match(/^@(theme|layer)\b([^{]*)\{?$/);
    if (atLayerMatch) {
      const kind = atLayerMatch[1] === 'theme' ? 'theme' : 'layer';
      currentBlock = kind;
      stack.push(kind);
      continue;
    }

    // Generic block open (selector { ... } or @media { ... }).
    if (/\{\s*$/.test(trimmed) && !atLayerMatch) {
      stack.push(currentBlock ?? 'other');
      continue;
    }

    if (trimmed === '}') {
      stack.pop();
      currentBlock = stack.length > 0 ? stack[stack.length - 1] : null;
      continue;
    }

    // Only enforce inside a @layer block; @theme and everything else is exempt.
    const insideLayer = stack.some((kind) => kind === 'layer');
    if (!insideLayer) continue;

    if (trimmed.startsWith('@apply')) {
      if (!trimmed.includes(';')) applyOpen = true;
      continue;
    }

    if (trimmed.startsWith('@')) continue; // @media, @keyframes, @screen, etc.

    if (cssDeclarationRegex.test(trimmed)) {
      violations.push(`${STYLES_CSS}:${i + 1} -> raw CSS declaration inside @layer (use @apply Tailwind utilities instead)`);
    }
  }
}

if (violations.length > 0) {
  console.error('Styling policy violations:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('No inline styles or raw CSS declarations found.');

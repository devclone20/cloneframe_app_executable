'use strict';
const assert = require('assert');
const MDLite = require('./mdlite.js');

let pass = 0, fail = 0;
function check(name, actual, predicate) {
  try {
    if (predicate(actual)) { pass++; console.log('PASS  ' + name); }
    else { fail++; console.log('FAIL  ' + name + '\n   got: ' + actual); }
  } catch (e) {
    fail++; console.log('ERROR ' + name + '\n   ' + e.message);
  }
}
function contains(sub) { return (s) => s.includes(sub); }
function notContains(sub) { return (s) => !s.includes(sub); }
function all(...preds) { return (s) => preds.every((p) => p(s)); }

// 1. bold + italic + inline code
check('bold/italic/inline-code', MDLite.render('**bold** and *italic* and `code`'),
  all(contains('<strong>bold</strong>'), contains('<em>italic</em>'), contains('<code>code</code>')));

// 2. headings h1-h3
check('headings', MDLite.render('# H1\n## H2\n### H3'),
  all(contains('<h1>H1</h1>'), contains('<h2>H2</h2>'), contains('<h3>H3</h3>')));

// 3. unordered + ordered lists
check('lists', MDLite.render('- a\n- b\n\n1. one\n2. two'),
  all(contains('<ul><li>a</li><li>b</li></ul>'), contains('<ol><li>one</li><li>two</li></ol>')));

// 4. blockquote
check('blockquote', MDLite.render('> quoted line'), contains('<blockquote>quoted line</blockquote>'));

// 5. hr
check('hr', MDLite.render('above\n\n---\n\nbelow'), contains('<hr>'));

// 6. fenced code block with highlighting (js)
check('fenced-js-highlight', MDLite.render('```js\nconst x = 1; // note\n```'),
  all(contains('class="codeblock" data-lang="js"'), contains('class="copybtn"'),
      contains('hl-kw'), contains('hl-num'), contains('hl-com')));

// 7. valid https link gets rel=noopener + target=_blank
check('valid-link', MDLite.render('[Site](https://example.com)'),
  all(contains('<a href="https://example.com"'), contains('target="_blank"'), contains('rel="noopener noreferrer"')));

// 8. javascript: link is rejected (not turned into <a>)
check('javascript-link-blocked', MDLite.render('[click](javascript:alert(1))'),
  notContains('<a '));

// 9. XSS: raw <script> tag in prose must be escaped, never executed as a tag
check('xss-script-tag', MDLite.render('<script>alert(1)</script>'),
  all(notContains('<script>'), contains('&lt;script&gt;')));

// 10. XSS: onerror attribute injection attempt in prose
check('xss-onerror-img', MDLite.render('<img src=x onerror=alert(1)>'),
  all(notContains('<img '), contains('&lt;img')));

// 11. XSS: script tag inside inline code span must stay escaped text, not become live markup
check('xss-inline-code', MDLite.render('`<script>alert(1)</script>`'),
  all(notContains('<script>'), contains('&lt;script&gt;')));

// 12. XSS: script tag inside fenced code block must stay escaped text
check('xss-fenced-code', MDLite.render('```js\n<script>alert(1)</script>\n```'),
  all(notContains('<script>alert'), contains('&lt;script&gt;')));

// 13. XSS: link label containing a script tag must not unescape
check('xss-link-label', MDLite.render('[<script>alert(1)</script>](https://example.com)'),
  all(notContains('<script>'), contains('&lt;script&gt;')));

// 14. XSS: attempted attribute breakout via quote in URL is neutralised (no raw quote survives)
check('xss-href-breakout', MDLite.render('[x](https://example.com/"onmouseover="alert(1))'),
  notContains('onmouseover="alert'));

// 15. highlight() standalone API + XSS safety on raw code with no lang
check('highlight-unknown-lang', MDLite.highlight('<b>hi</b>', 'made-up-lang'),
  all(notContains('<b>'), contains('&lt;b&gt;')));

// 16. highlight() python
check('highlight-python', MDLite.highlight('def foo():\n    return "hi"  # comment', 'python'),
  all(contains('hl-kw'), contains('hl-str'), contains('hl-com')));

// 17. highlight() solidity
check('highlight-solidity', MDLite.highlight('function foo() public payable returns (uint256) { return 1; }', 'solidity'),
  all(contains('hl-kw'), contains('hl-fn')));

// 18. line breaks preserved within paragraph
check('line-breaks', MDLite.render('line one\nline two'), contains('line one<br>line two'));

// 19. non-string input does not throw
check('non-string-input-safe', (() => { try { return MDLite.render(null) === '' && MDLite.highlight(42, 'js') === ''; } catch (e) { return false; } })(),
  (v) => v === true);

// 20. ampersand and quotes in plain prose are escaped
check('escape-amp-quotes', MDLite.render('Tom & Jerry said "hi" and \'bye\''),
  all(contains('&amp;'), contains('&quot;'), contains('&#39;')));

console.log('\n' + pass + ' passed, ' + fail + ' failed (of ' + (pass + fail) + ')');
process.exit(fail > 0 ? 1 : 0);

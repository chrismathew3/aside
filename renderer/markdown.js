'use strict';

// Sanitize model output before adding highlighting or trusted UI controls.
function renderMarkdown(container, markdown) {
  const scrollPositions = [...container.querySelectorAll('pre')].map(pre => pre.scrollLeft);
  container.innerHTML = DOMPurify.sanitize(marked.parse(markdown));

  container.querySelectorAll('pre > code').forEach((code, index) => {
    const pre = code.parentElement;
    const source = code.textContent;
    const requested = [...code.classList].find(name => name.startsWith('language-'))?.slice(9);
    const plain = ['text', 'txt', 'plaintext', 'plain'].includes(requested);
    const language = requested && hljs.getLanguage(requested) ? requested : null;
    let highlighted;
    if (language) {
      highlighted = hljs.highlight(source, { language, ignoreIllegals: true });
    } else if (!requested && source.trim()) {
      highlighted = hljs.highlightAuto(source, ['typescript', 'javascript', 'python', 'json', 'sql', 'bash']);
    }
    if (highlighted) code.innerHTML = highlighted.value;
    code.classList.add('hljs');
    pre.scrollLeft = scrollPositions[index] || 0;

    const block = document.createElement('div');
    block.className = 'code-block';
    const header = document.createElement('div');
    header.className = 'code-header';
    const label = document.createElement('span');
    label.textContent = plain ? 'Text' : (requested || highlighted?.language || 'Code');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy code');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(source);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Try again';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
    });
    header.append(label, copy);
    pre.before(block);
    block.append(header, pre);
  });
}

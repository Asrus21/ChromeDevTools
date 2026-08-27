// O coletor que vive DENTRO da página.
//
// Por que isto existe: cada chamada de ferramenta abre uma conexão nova com o
// navegador e a fecha no fim (é o padrão recomendado pela Cloudflare — uma
// sessão só aceita uma conexão de Worker por vez). Ou seja: um
// `page.on('console')` registrado numa chamada morre antes da próxima. Um
// script injetado na página, não: ele continua rodando lá e vai enchendo um
// buffer que a gente drena quando volta.
//
// Os scripts são STRINGS de propósito. O tsconfig do Worker não carrega a lib
// DOM (ela conflita com os tipos do Workers), então este código não seria
// tipável aqui de qualquer jeito — e como string ele também não corre risco de
// ser mexido pelo bundler. Os testes compilam estas strings com `node:vm` para
// garantir que pelo menos são JavaScript válido.

/** Quantas entradas o buffer da página segura antes de descartar as antigas. */
export const PAGE_BUFFER_MAX = 300;

/**
 * Script de instalação. É idempotente: se já houver coletor na página, sai na
 * primeira linha. Registramos ele também via `evaluateOnNewDocument`, então
 * ele se reinstala sozinho a cada navegação.
 *
 * @param dialogDefault o que fazer com alert/confirm/prompt sem ninguém para
 *   responder. Diálogo nativo trava a página inteira até alguém decidir, e
 *   entre duas chamadas de ferramenta não há ninguém escutando — então
 *   respondemos aqui mesmo e registramos o que apareceu.
 */
export function collectorInstallSource(
  dialogDefault: 'dismiss' | 'accept',
  max: number = PAGE_BUFFER_MAX
): string {
  return `(() => {
  if (window.__mcpCollector) return 'already';
  var MAX = ${JSON.stringify(max)};
  var ACCEPT = ${JSON.stringify(dialogDefault === 'accept')};
  var state = { console: [], network: [], dialogs: [] };
  window.__mcpCollector = state;

  function push(arr, item) {
    arr.push(item);
    if (arr.length > MAX) arr.splice(0, arr.length - MAX);
  }
  function fmt(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    try {
      var text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch (e) {
      return String(value);
    }
  }
  function clip(text, size) {
    text = String(text === undefined || text === null ? '' : text);
    return text.length > size ? text.slice(0, size) + '…' : text;
  }

  var levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (var i = 0; i < levels.length; i++) {
    (function (level) {
      var original = console[level];
      if (typeof original !== 'function') return;
      console[level] = function () {
        var args = Array.prototype.slice.call(arguments);
        push(state.console, {
          type: level,
          text: clip(args.map(fmt).join(' '), 2000),
          at: Date.now()
        });
        return original.apply(console, args);
      };
    })(levels[i]);
  }

  window.addEventListener('error', function (event) {
    push(state.console, {
      type: 'pageerror',
      text: clip(event.message, 2000),
      stack: event.error && event.error.stack ? clip(event.error.stack, 2000) : null,
      at: Date.now()
    });
  });
  window.addEventListener('unhandledrejection', function (event) {
    push(state.console, {
      type: 'unhandledrejection',
      text: clip(fmt(event.reason), 2000),
      at: Date.now()
    });
  });

  // PerformanceObserver pega TODA requisição (imagem, css, script, fetch...),
  // inclusive as que começaram antes deste script rodar (buffered: true). O que
  // ele não tem é o método HTTP — por isso os patches de fetch/XHR abaixo.
  try {
    var observer = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j];
        var isDocument = entry.entryType === 'navigation';
        push(state.network, {
          url: clip(entry.name, 1000),
          method: isDocument ? 'GET' : null,
          status: typeof entry.responseStatus === 'number' ? entry.responseStatus : null,
          type: isDocument ? 'document' : entry.initiatorType || null,
          ms: Math.round(entry.duration),
          bytes: typeof entry.transferSize === 'number' ? entry.transferSize : null,
          at: Date.now(),
          via: isDocument ? 'navigation' : 'perf'
        });
      }
    });
    observer.observe({ type: 'resource', buffered: true });
    observer.observe({ type: 'navigation', buffered: true });
  } catch (e) {}

  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var started = Date.now();
      var method = (init && init.method) || (input && input.method) || 'GET';
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      function record(status) {
        push(state.network, {
          url: clip(url, 1000),
          method: String(method).toUpperCase(),
          status: status,
          type: 'fetch',
          ms: Date.now() - started,
          bytes: null,
          at: started,
          via: 'fetch'
        });
      }
      return originalFetch.apply(this, arguments).then(
        function (response) {
          record(response.status);
          return response;
        },
        function (error) {
          record(null);
          throw error;
        }
      );
    };
  }

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof XHR.prototype.open === 'function') {
    var originalOpen = XHR.prototype.open;
    var originalSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__mcpRequest = { method: String(method).toUpperCase(), url: String(url) };
      return originalOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var info = this.__mcpRequest;
      if (info) {
        var started = Date.now();
        var xhr = this;
        this.addEventListener('loadend', function () {
          push(state.network, {
            url: clip(info.url, 1000),
            method: info.method,
            status: xhr.status || null,
            type: 'xhr',
            ms: Date.now() - started,
            bytes: null,
            at: started,
            via: 'xhr'
          });
        });
      }
      return originalSend.apply(this, arguments);
    };
  }

  function recordDialog(kind, message, handledAs) {
    push(state.dialogs, {
      kind: kind,
      message: clip(message, 1000),
      at: Date.now(),
      handledAs: handledAs
    });
  }
  window.alert = function (message) {
    recordDialog('alert', message, 'dismissed');
  };
  window.confirm = function (message) {
    recordDialog('confirm', message, ACCEPT ? 'accepted' : 'dismissed');
    return ACCEPT;
  };
  window.prompt = function (message, fallback) {
    recordDialog('prompt', message, ACCEPT ? 'accepted' : 'dismissed');
    return ACCEPT ? (fallback === undefined ? '' : fallback) : null;
  };

  return 'installed';
})()`;
}

/**
 * Esvazia os buffers da página e devolve o conteúdo. Devolve `null` quando o
 * coletor não está instalado (página recém-criada, ou navegação que rodou
 * antes da injeção) — aí o chamador reinstala.
 */
export const COLLECTOR_DRAIN_SOURCE = `(() => {
  var state = window.__mcpCollector;
  if (!state) return null;
  var drained = { console: state.console, network: state.network, dialogs: state.dialogs };
  state.console = [];
  state.network = [];
  state.dialogs = [];
  return drained;
})()`;

/**
 * dsh-image-formats — client half.
 *
 * The conversation upload path rejects every image MIME outside
 * PNG/JPEG/WebP/GIF before a request is sent. This module intercepts AVIF
 * files on their way into the composer (paste, drop, and the hidden file
 * picker), decodes them with the browser, re-encodes them as PNG, and then
 * feeds the PNG back through the same hidden input so the official upload
 * pipeline keeps working unchanged.
 *
 * The file is intentionally hand-written, not bundled: the module loader
 * format is small and stable, and the plugin has no client dependencies.
 */

window.__ModuleLoader__.load({
  id: 'dsh-image-formats',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var inject = [];
    var name = 'image-formats';

    var CARD_SELECTOR = '[data-composer-card="true"]';
    var INPUT_SELECTOR = 'input[type="file"][hidden]';
    var MAX_EDGE = 2048;
    var MAX_PNG_BYTES = 6 * 1024 * 1024;
    // Files fed back through the hidden input: the synthetic change must reach
    // the official intake handler without being intercepted a second time.
    var selfFeeds = new WeakSet();

    function isFile(value) {
      return typeof File !== 'undefined' && value instanceof File;
    }

    function isAvif(file) {
      if (!isFile(file)) return false;
      var type = (file.type || '').toLowerCase();
      if (type !== '') return type === 'image/avif';
      return /\.avif$/i.test(file.name || '');
    }

    function filesFromTransfer(transfer) {
      var files = [];
      if (transfer === null || transfer === undefined) return files;
      if (transfer.files !== null && transfer.files !== undefined && transfer.files.length > 0) {
        for (var index = 0; index < transfer.files.length; index += 1) files.push(transfer.files[index]);
        return files;
      }
      var items = transfer.items;
      if (items === null || items === undefined) return files;
      for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        var item = items[itemIndex];
        if (item.kind !== 'file') continue;
        var file = item.getAsFile();
        if (file !== null) files.push(file);
      }
      return files;
    }

    function composerCard(node) {
      var element = node instanceof Element ? node : node && node.parentElement;
      if (element !== null && element !== undefined) {
        var card = element.closest(CARD_SELECTOR);
        if (card !== null) return card;
      }
      var cards = Array.prototype.slice.call(document.querySelectorAll(CARD_SELECTOR));
      var visible = cards.filter(function (candidate) {
        return candidate.isConnected && candidate.closest('[inert], [hidden]') === null;
      });
      return visible.length === 0 ? null : visible[visible.length - 1];
    }

    function fileInput(card) {
      if (card === null || card === undefined) return null;
      return card.querySelector(INPUT_SELECTOR);
    }

    function feed(card, files) {
      var input = fileInput(card);
      if (input === null || input.disabled || files.length === 0) return false;
      var transfer = new DataTransfer();
      for (var index = 0; index < files.length; index += 1) transfer.items.add(files[index]);
      input.files = transfer.files;
      selfFeeds.add(input);
      try {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } finally {
        selfFeeds.delete(input);
      }
      return true;
    }

    function decode(file) {
      if (typeof createImageBitmap === 'function') {
        return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
          return createImageBitmap(file);
        });
      }
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var image = new Image();
        image.onload = function () {
          image.__imageFormatsUrl = url;
          resolve(image);
        };
        image.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error('the browser cannot decode this image'));
        };
        image.src = url;
      });
    }

    function sourceSize(source) {
      var width = source.width || source.naturalWidth || 0;
      var height = source.height || source.naturalHeight || 0;
      return { width: width, height: height };
    }

    function renderPng(source, maxEdge) {
      var size = sourceSize(source);
      if (size.width === 0 || size.height === 0) throw new Error('the image has no pixels');
      var scale = Math.min(1, maxEdge / Math.max(size.width, size.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(size.width * scale));
      canvas.height = Math.max(1, Math.round(size.height * scale));
      var context = canvas.getContext('2d');
      if (context === null) throw new Error('canvas 2D is unavailable');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob === null) reject(new Error('PNG encoding failed'));
          else resolve(blob);
        }, 'image/png');
      });
    }

    function release(source) {
      if (typeof source.close === 'function') source.close();
      if (source.__imageFormatsUrl !== undefined) URL.revokeObjectURL(source.__imageFormatsUrl);
    }

    function pngName(name) {
      var base = (name || 'image').replace(/\.[^.\\/]*$/, '');
      return (base.length === 0 ? 'image' : base) + '.png';
    }

    async function convert(file) {
      var source;
      try {
        source = await decode(file);
      } catch (error) {
        console.warn('[dsh-image-formats] could not decode', file.name, error);
        return file;
      }
      try {
        var edge = MAX_EDGE;
        var blob = await renderPng(source, edge);
        while (blob.size > MAX_PNG_BYTES && edge > 1024) {
          edge = Math.round(edge * 0.75);
          blob = await renderPng(source, edge);
        }
        return new File([blob], pngName(file.name), {
          type: 'image/png',
          lastModified: file.lastModified || Date.now(),
        });
      } catch (error) {
        console.warn('[dsh-image-formats] could not convert', file.name, error);
        return file;
      } finally {
        release(source);
      }
    }

    async function convertAll(files) {
      var out = [];
      for (var index = 0; index < files.length; index += 1) {
        out.push(isAvif(files[index]) ? await convert(files[index]) : files[index]);
      }
      return out;
    }

    function hasText(transfer) {
      if (transfer === null || transfer === undefined) return false;
      return transfer.getData('text/plain').length > 0;
    }

    function intercept(event, files) {
      var convertible = files.filter(isAvif);
      if (convertible.length === 0) return false;
      var card = composerCard(event.target);
      if (card === null) return false;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      void convertAll(files).then(function (converted) {
        if (!card.isConnected) return;
        if (!feed(card, converted)) {
          console.warn('[dsh-image-formats] the composer is not accepting files right now');
        }
      });
      return true;
    }

    function onPaste(event) {
      if (event.defaultPrevented || event.clipboardData === null) return;
      if (hasText(event.clipboardData)) return;
      var files = filesFromTransfer(event.clipboardData);
      if (files.length === 0) return;
      intercept(event, files);
    }

    function onDrop(event) {
      if (event.defaultPrevented || event.dataTransfer === null) return;
      var files = filesFromTransfer(event.dataTransfer);
      if (files.length === 0) return;
      intercept(event, files);
    }

    function onChange(event) {
      var input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
      if (selfFeeds.has(input)) return;
      if (input.closest(CARD_SELECTOR) === null) return;
      var files = input.files === null ? [] : Array.prototype.slice.call(input.files);
      if (files.length === 0 || !files.some(isAvif)) return;
      input.value = '';
      intercept(event, files);
    }

    function install() {
      document.addEventListener('paste', onPaste, true);
      document.addEventListener('drop', onDrop, true);
      document.addEventListener('change', onChange, true);
      return function () {
        document.removeEventListener('paste', onPaste, true);
        document.removeEventListener('drop', onDrop, true);
        document.removeEventListener('change', onChange, true);
      };
    }

    function apply(ctx) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;
      var previous = window.__dshImageFormatsDispose;
      if (typeof previous === 'function') previous();
      var dispose = install();
      window.__dshImageFormatsDispose = dispose;
      if (ctx !== null && ctx !== undefined && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return dispose;
        }, 'image-formats: composer intake');
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});

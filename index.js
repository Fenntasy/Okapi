/* global document window */
const fs = require("fs-extra");
const path = require("path");
const puppeteer = require("puppeteer");

const readFile = (root, filename) =>
  new Promise((resolve, reject) =>
    fs.readFile(
      path.join(__dirname, root, filename),
      "utf8",
      (err, text) => (err ? reject(err) : resolve(text))
    )
  ).catch(() => {});

const writeFile = (root, filename, buffer) =>
  new Promise((resolve, reject) =>
    fs.writeFile(
      path.join(__dirname, root, filename),
      buffer,
      (err, text) => (err ? reject(err) : resolve(text))
    )
  ).catch(() => {});

const setupVCR = (browser, page, VCR) =>
  page
    .exposeFunction("readfile", readFile)
    .then(() => page.exposeFunction("writefile", writeFile))
    .then(() => readFile(".", "fetch-vcr-browser-bundle.js"))
    .then(fetchVCR => page.evaluateOnNewDocument(fetchVCR))
    .then(() =>
      page.evaluateOnNewDocument(VCR => {
        window.fetch = window.fetchVCR;
        window.fetch.configure({
          fixturePath: VCR.fixturePath,
          mode: VCR.mode
        });
      }, VCR)
    )
    .then(() => [browser, page]);

const foldP = (pred, list) =>
  list.reduce((acc, elt) => acc.then(() => pred(elt)), Promise.resolve());

const Wapiti = (function() {
  let commands = [];
  const VCR = {
    active: false,
    fixturePath: "./_fixtures",
    mode: "cache"
  };

  return {
    capture(func) {
      commands.push((page, results) =>
        page.evaluate(func).then(evaluation => results.push(evaluation))
      );
      return this;
    },
    captureUrl() {
      commands.push((page, results) =>
        Promise.resolve(results.push(page.url()))
      );
      return this;
    },
    click(selector, options = { button: "left", clickCount: 1, delay: 0 }) {
      commands.push(page => page.click(selector, options));
      return this;
    },
    clickAndWaitForNewTab(
      selector,
      options = { button: "left", clickCount: 1, delay: 0 }
    ) {
      commands.push((page, _, browser) => {
        page.click(selector, options);
        return new Promise(resolve => {
          browser.on("targetcreated", resolve);
        });
      });
      return this;
    },
    fillForm(options) {
      const selectors = Object.keys(options);
      commands.push(page =>
        foldP(selector => page.type(selector, options[selector]), selectors)
          .then(() =>
            page.evaluate(
              firstInput => document.querySelector(firstInput).form.submit(),
              selectors[0]
            )
          )
          .then(() => page.waitForNavigation({ waitUntil: "networkidle0" }))
      );
      return this;
    },
    goto(url) {
      commands.push(page => page.goto(url, { waitUntil: "networkidle0" }));
      return this;
    },
    nextTab() {
      commands.push((page, _, browser) => {
        return browser.pages().then(pages => {
          if (pages.length === 1) {
            // eslint-disable-next-line no-console
            console.warn(
              "Warning, attempting to change tab when there is only one \n" +
                "You may need to call clickAndWaitForNewTab() before switching tab"
            );
          }
          return {
            newWapitiPage:
              pages[(pages.findIndex(p => p === page) + 1) % pages.length]
          };
        });
      });
      return this;
    },
    previousTab() {
      commands.push((page, _, browser) => {
        return browser.pages().then(pages => {
          if (pages.length === 1) {
            // eslint-disable-next-line no-console
            console.warn(
              "Warning, attempting to change tab when there is only one \n" +
                "You may need to call clickAndWaitForNewTab() before switching tab"
            );
          }
          return {
            newWapitiPage:
              pages[
                Math.abs(pages.findIndex(p => p === page) - 1) % pages.length
              ]
          };
        });
      });
      return this;
    },
    puppeteer(fun) {
      commands.push((page, _, browser) => Promise.resolve(fun(page, browser)));
      return this;
    },
    run: function() {
      const noSandbox = process.env.IN_CI || process.env.IN_DOCKER;
      const options = noSandbox ? { args: ["--no-sandbox"] } : {};
      return puppeteer
        .launch(options)
        .then(browser => Promise.all([browser, browser.pages()]))
        .then(([browser, pages]) => [browser, pages[0]])
        .then(
          ([browser, page]) =>
            VCR.active ? setupVCR(browser, page, VCR) : [browser, page]
        )
        .then(([browser, page]) => {
          let results = [];
          return foldP(
            command =>
              command(page, results, browser).then(data => {
                if (data !== undefined && data.newWapitiPage !== undefined) {
                  page = data.newWapitiPage;
                }
                return Promise.resolve();
              }),
            commands
          )
            .then(() => {
              browser.close();

              // Reset Wapiti
              commands = [];
              VCR.active = false;
            })
            .then(() =>
              Promise.resolve(results.length === 1 ? results[0] : results)
            );
        });
    },
    setupVCR(options = {}) {
      VCR.active = true;
      if (options.fixturePath) {
        VCR.fixturePath = options.fixturePath;
      }
      if (options.mode) {
        VCR.mode = options.mode;
      }
      fs.ensureDir(VCR.fixturePath);
      return this;
    },
    typeIn(selector, value) {
      commands.push(page => page.type(selector, value));
      return this;
    }
  };
})();

module.exports = Wapiti;

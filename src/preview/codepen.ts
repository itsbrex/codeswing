import axios from "axios";
import * as FormData from "form-data";
import * as path from "path";
import * as vscode from "vscode";
import { getFileOfType } from ".";
import { EXTENSION_NAME, SWING_FILE, URI_PATTERN } from "../constants";
import { store, SwingFileType } from "../store";
import { getFileContents, getUriContents } from "../utils";
import { getCDNJSLibraries } from "./libraries/cdnjs";

const CODEPEN_URI =
  "https://codespaces-contrib.github.io/codeswing/codepen.html";

const SCRIPT_PATTERN = /<script src="(?<url>[^"]+)"><\/script>/gi;
const STYLE_PATTERN = /<link href="(?<url>[^"]+)" rel="stylesheet" \/>/gi;

interface PenDefinition {
  title: string;
  description: string;
  html?: string;
  html_pre_processor?: string;
  css?: string;
  css_pre_processor?: string;
  js?: string;
  js_pre_processor?: string;
  css_external?: string;
  js_external?: string;
  tags: string[];
}

function matchAllUrls(string: string, regex: RegExp): string[] {
  let match;
  let results = [];
  while ((match = regex.exec(string)) !== null) {
    if (match.index === regex.lastIndex) {
      regex.lastIndex++;
    }

    results.push(match!.groups!.url);
  }
  return results;
}

function resolveLibraries(libraries: string[]) {
  return Promise.all(
    libraries.map(async (library: string) => {
      const isUrl = library.match(URI_PATTERN);
      if (isUrl) {
        return library;
      } else {
        const libraries = await getCDNJSLibraries();
        const libraryEntry = libraries.find((lib) => lib.name === library);

        if (!libraryEntry) {
          return "";
        }

        return libraryEntry.latest;
      }
    })
  );
}

export async function exportSwingToCodePen(uri: vscode.Uri) {
  await vscode.workspace.saveAll();

  const title = path.basename(uri.path);
  const files = (await vscode.workspace.fs.readDirectory(uri)).map(
    ([file, type]) => file
  );

  const data: PenDefinition = {
    title,
    description: title,
    tags: ["codeswing"],
  };

  const markupFile = getFileOfType(uri, files, SwingFileType.markup);
  const scriptFile = getFileOfType(uri, files, SwingFileType.script);
  const stylesheetFile = getFileOfType(uri, files, SwingFileType.stylesheet);

  if (markupFile) {
    data.html = await getUriContents(markupFile);
    data.html_pre_processor = markupFile.path.endsWith(".pug") ? "pug" : "none";
  }

  if (scriptFile) {
    data.js = await getUriContents(scriptFile);

    const extension = path.extname(scriptFile.path);
    switch (extension) {
      case ".babel":
      case ".jsx":
        data.js_pre_processor = "babel";
        break;
      case ".ts":
      case ".tsx":
        data.js_pre_processor = "typescript";
        break;
      default:
        data.js_pre_processor = "none";
    }
  }

  if (stylesheetFile) {
    data.css = await getUriContents(stylesheetFile);
    switch (path.extname(stylesheetFile.path)) {
      case ".scss":
        data.css_pre_processor = "scss";
        break;
      case ".sass":
        data.css_pre_processor = "sass";
        break;
      case ".less":
        data.css_pre_processor = "less";
        break;
      default:
        data.css_pre_processor = "none";
        break;
    }
  }

  let scripts: string[] = [];
  let styles: string[] = [];

  if (files.includes("scripts")) {
    const scriptsContent = await getFileContents(uri, "scripts");
    scripts = matchAllUrls(scriptsContent, SCRIPT_PATTERN);
  }

  if (files.includes("styles")) {
    const stylesContent = await getFileContents(uri, "styles");
    styles = matchAllUrls(stylesContent, STYLE_PATTERN);
  }

  if (files.includes(SWING_FILE)) {
    const manifestContent = await getFileContents(uri, SWING_FILE);
    if (manifestContent) {
      let manifest;
      try {
        manifest = JSON.parse(manifestContent);
      } catch (e) {
        throw new Error(
          "The swing's manifest file appears to be invalid. Please check it and try again."
        );
      }
      if (manifest.scripts && manifest.scripts.length > 0) {
        if (
          manifest.scripts.find((script: any) => script === "react") &&
          data.js_pre_processor === "none"
        ) {
          data.js_pre_processor = "babel";
        }

        scripts = scripts.concat(await resolveLibraries(manifest.scripts));
      }

      if (manifest.styles && manifest.styles.length > 0) {
        styles = styles.concat(await resolveLibraries(manifest.styles));
      }
    }
  }

  if (scripts.length > 0) {
    data.js_external = scripts.join(";");
  }

  if (styles.length > 0) {
    data.css_external = styles.join(";");
  }

  const formData = new FormData();
  formData.append("text", JSON.stringify(data));

  const response = axios.post("https://file.io/?expires=1", formData, {
    headers: formData.getHeaders(),
  });

  const definitionFile = (await response).data.link;
  const definitionUrl = encodeURIComponent(definitionFile!);

  return vscode.env.openExternal(
    vscode.Uri.parse(`${CODEPEN_URI}?pen=${definitionUrl}`)
  );
}

export function registerCodePenCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${EXTENSION_NAME}.exportToCodePen`,
      async () =>
        vscode.window.withProgress(
          {
            title: "Exporting swing...",
            location: vscode.ProgressLocation.Notification,
          },
          () => exportSwingToCodePen(store.activeSwing!.rootUri)
        )
    )
  );
}
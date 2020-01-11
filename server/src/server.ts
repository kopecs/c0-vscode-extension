import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  Hover,
  MarkupContent,
  LocationLink,
  CompletionParams,
  Range,
  Position,
  FileChangeType,
  TextDocumentChangeEvent,
  ParameterInformation,
  SignatureInformation,
  WorkspaceFolder,
  DocumentFormattingParams,
  TextEdit
} from 'vscode-languageserver';

import { basicLexing } from './lex';
import { openFiles, parseTextDocument, invalidate, invalidateAll } from "./validate-program";

import * as ast from "./ast";
import { isInside, findStatement, findGenv, comparePositions } from "./ast-search";
import { typeToString, expressionToString } from './print';

import * as path from "path";
import * as fs from "fs";
import { EnvEntry } from './typecheck/types';
import { getFunctionDeclaration, actualType, getTypedefDefinition, getStructDefinition } from './typecheck/globalenv';
import { Maybe, Just, Nothing, getLibpath } from './util';
import { Ordering } from './util';
import { getCompletionContext, CompletionContextKind } from './c0Completions';
import { synthExpression } from './typecheck/expressions';

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
const documents: TextDocuments = new TextDocuments();

let hasWorkspaceFolderCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {  
  const capabilities = params.capabilities;

  // Does the client support the `workspace/configuration` request?
  // If not, we will fall back using global settings
  hasWorkspaceFolderCapability = Boolean(capabilities.workspace!.workspaceFolders);

  return {
    capabilities: {
      textDocumentSync: documents.syncKind,
      completionProvider: {
        triggerCharacters: [".", ">"], // ">" is for ->
        resolveProvider: false
      },
      hoverProvider: true,
      definitionProvider: true,
      signatureHelpProvider: { triggerCharacters: ["(", ","] },
      documentFormattingProvider: true
    }
  };
});

connection.onInitialized(() => {
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(event => {
      connection.console.log('Workspace folder change event received.');
    });
  }

  // Commented out since making them read-only causes issues with 
  // updating the plugin
  // // Change header files to be read-only so they aren't accidentally editted
  // fs.readdirSync(path.join(path.dirname(process.argv[1]), 'c0lib')).forEach((file) => {
  //   fs.chmodSync(path.join(path.dirname(process.argv[1]), 'c0lib', file), '444');
  // });
});

/**
 * Returns the text of the given file, possibly using a file
 * open in the editor. 
 * @param uri URI with file:// protocol
 */
export function openFile(uri: string): string {
  // Check if the document is open, and use that instead
  for (const document of documents.all()) {
    if (document.uri === uri) return document.getText();
  }

  // Otherwise open the document, potentially
  // throwing if it doesn't exist
  return fs.readFileSync(new URL(uri), "utf-8");
}

type Dependencies = {
  /** Path to project.txt */
  uri: string, 
  /** List of files which should be loaded before this one */
  dependencies: string[] 
};

function getDependencies(name: string, configPaths: URL[]): Maybe<Dependencies> {
  /** Takes a line from project.txt and removes comments and leading/trailing whitespace */
  function parseLine(line: string): string {
    const index = line.indexOf("//");
    return (index === - 1 ? line : line.substr(0, index)).trim();
  }

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      const lines: string[][] = fs
        .readFileSync(configPath, { encoding: "utf-8" })
        .split("\n")
        .map(line => parseLine(line).split(" ").map(file => file.trim()));

      // Filenames should be relative to the config file's location
      const base = path.dirname(configPath.toString());
      // path will add platform-specific separators, which is not what we want
      const fname = path.relative(base, name).replace(path.sep, "/");

      for (const files of lines) {
        const dependencies = [];
        for (const file of files) {
          // Lines will be blank if they are all whitespace
          // or all comments 
          if (file === '') continue;

          if (file === fname) {
            return Just({ uri: `${base}/project.txt`, dependencies });
          }

          // Note that URIs always use /
          // (even on Windows)
          dependencies.push(`${base}/${file}`);
        }
      }
    }
  }
  return Nothing;
}

/**
 * The cached project.txt for each file, or null if invalid
 */
const cachedProjects = new Map<string, Dependencies>();

connection.onDidChangeWatchedFiles(async params => {
  for (const change of params.changes) {
    invalidate(change.uri);

    if (change.uri.endsWith('/project.txt')) {
      if (change.type === FileChangeType.Created) {
        // Invalidate all project.txt caches, since this may be a new project file
        cachedProjects.clear();
      } else {
        // Invalidate all references to this project.txt
        cachedProjects.forEach((value, key) => {
          if (value.uri === change.uri) {
            cachedProjects.delete(key);
          }
        });
      }

      // Ordering of files may have changed, screwing dependencies.
      invalidateAll();

      // Reload diagnostics for all documents 
      for (const document of documents.all()) {
        await validateTextDocument({ document });
      }
    }
  }
});

documents.onDidOpen(validateTextDocument);
documents.onDidChangeContent(async (change) => {
  invalidate(change.document.uri);
  await validateTextDocument(change);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
async function validateTextDocument(change: TextDocumentChangeEvent) {
  let dependencies: string[] = [];
  const diagnostics: Diagnostic[] = [];

  const project = cachedProjects.get(change.document.uri);
  if (project) {
    dependencies = project.dependencies;
  } else {
    // Look for a config file
    const dir = path.dirname(change.document.uri);

    // maybe just use a VSCode config file...
    const folders = await connection.workspace.getWorkspaceFolders();

    const maybeDependencies = getDependencies(change.document.uri, [
      `${dir}/project.txt`,
      `${dir}/../project.txt`, // Look one folder above
      folders && folders.length ? `${folders[0].uri}/project.txt` : ""
    ].map(p => new URL(p)));

    if (!maybeDependencies.hasValue) {
      diagnostics.push(Diagnostic.create(
        Range.create(Position.create(0, 0), Position.create(0, 0)),
        `No valid project.txt found for the current document. Completions and other features may not work as expected`,
        DiagnosticSeverity.Warning,
        undefined,
        change.document.uri));

      dependencies = [];
    }
    else {
      dependencies = maybeDependencies.value.dependencies;
      cachedProjects.set(change.document.uri, maybeDependencies.value);
    }
  }

  const parseErrors = await parseTextDocument(dependencies, change.document);

  connection.sendDiagnostics({ uri: change.document.uri, diagnostics: [...diagnostics, ...parseErrors] });
}

/**
 * Turns a string with C0 code and wraps it
 * with Markdown code fences
 */
function mkCodeString(s: string): string {
  return `\`\`\`c0\n${s}\n\`\`\``;
}

/**
 * Turns a string with C0 code into a MarkupContent object,
 * which can be sent as part of various LSP responses
 */
function mkMarkdownCode(s: string): MarkupContent {
  return {
    kind: "markdown",
    value: mkCodeString(s)
  };
}

// This handler provides the initial list of the completion items.
connection.onCompletion(async (completionInfo: CompletionParams): Promise<CompletionItem[]> => {
  // TODO: use completionInfo to figure out if we should add keywords or not

  // The pass parameter contains the position of the text document in
  // which code complete got requested.
  const keywords: CompletionItem[] =
    basicLexing.identifier.keywords.keyword.map(word => ({
      label: word,
      kind: CompletionItemKind.Keyword,
    }));

  const pos = ast.fromVscodePosition(completionInfo.position);

  const decls = openFiles.get(completionInfo.textDocument.uri);
  if (decls === undefined) return keywords;

  // Add all gdecl names
  const functionDecls: Map<string, CompletionItem> = new Map();
  const typedefs: CompletionItem[] = [];
  const locals: CompletionItem[] = [];
  const fieldNames: CompletionItem[] = [];

  const folders = await connection.workspace.getWorkspaceFolders();

  /**
   * Converts a URI-format file path to a more readable one, local to the directory.
   * @param uri The URI to convert, with the leading file://
   */
  function uriToWorkspace(uri: string | undefined): string | undefined {
    if (!uri) {
      return undefined;
    }

    // If relative to a workspace, print relative path; otherwise, default to base file name
    if (folders) {
      for (const folder of folders) {
        if (uri.indexOf(folder.uri) === 0) {
          return path.relative(folder.uri, uri);
        }
      }
    }

    // TODO: Check if it is in the include directory (library directory)

    return path.parse(uri).base;
  }

  // TODO: only show decls up to this point
  for (const decl of decls.decls) {
    // Stop once we get to a decl after the curser position
    // in the current file
    if (decl.loc && decl.loc.source === completionInfo.textDocument.uri
        && comparePositions(pos, decl.loc?.start) === Ordering.Less)
      break;

    switch (decl.tag) {
      case "TypeDefinition":
        typedefs.push({
          label: decl.definition.id.name,
          kind: CompletionItemKind.Interface,
          documentation: mkMarkdownCode(`typedef ${typeToString(decl.definition.kind)} ${decl.definition.id.name}`),
          detail: uriToWorkspace(decl.loc?.source || undefined)
        });
        break;

      case "FunctionTypeDefinition":
        typedefs.push({
          label: decl.definition.id.name,
          kind: CompletionItemKind.Interface,
          documentation: mkMarkdownCode(`typedef ${typeToString({ tag: "FunctionType", definition: decl.definition })}`),
          detail: uriToWorkspace(decl.loc?.source || undefined)
        });
        break;

      case "StructDeclaration":
        if (decl.definitions === null) break;
        for (const field of decl.definitions) {
          fieldNames.push({
            label: field.id.name,
            kind: CompletionItemKind.Field,
            documentation: mkMarkdownCode(`struct ${decl.id.name} {\n  ...\n  ${typeToString(field.kind)} ${field.id.name};\n};`),
            detail: uriToWorkspace(decl.loc?.source || undefined)
          });
        }
        break;

      case "FunctionDeclaration": {
        // Prefer to use contracts from a function definition
        if (decl.body || !functionDecls.has(decl.id.name)) {
          const requires = decl.preconditions.map(precond =>
              `//@requires ${expressionToString(precond)}`);
          const ensures = decl.postconditions.map(postcond =>
              `//@ensures ${expressionToString(postcond)}`);

          functionDecls.set(decl.id.name, {
            label: decl.id.name,
            kind: CompletionItemKind.Function,
            documentation: mkMarkdownCode(
              `${[typeToString({ tag: "FunctionType", definition: decl }), ...requires, ...ensures].join("\n")}`),
            detail: uriToWorkspace(decl.loc?.source || undefined)
          });
        }
        if (decl.body) {
          // Look in the function body for local variables
          if (!isInside(pos, decl.body.loc)) break;

          const searchResult = findStatement(decl.body, null, { pos, genv: decls });
          if (searchResult === null || searchResult.environment === null) break;

          const doc = documents.get(completionInfo.textDocument.uri);
          if (doc) {
            const context = getCompletionContext(
              doc.getText(),
              doc.offsetAt(completionInfo.position));

            if (context) {
              switch (context.tag) {
                case CompletionContextKind.StructAccess:
                  try {
                    // Type safety? :D 
                    const type = <ast.Type>synthExpression(decls, searchResult.environment, null, <ast.Expression>context.expr);
                    let actual;
                    if (context.derefenced && type.tag === "PointerType") {
                      actual = actualType(decls, type.argument);
                    }
                    else {
                      actual = actualType(decls, type);
                    }
                    const structname = (<ast.StructType>actual).id?.name || "";

                    const struct = getStructDefinition(decls, structname);
                    if (struct && struct.definitions) {
                      return struct.definitions.map(field => ({
                          label: field.id.name,
                          kind: CompletionItemKind.Field,
                          documentation: mkMarkdownCode(`struct ${struct.id.name} {\n  ...\n  ${typeToString(field.kind)} ${field.id.name};\n};`),
                          detail: uriToWorkspace(field.loc?.source || undefined)
                      }));
                    }
                  }
                  catch (e) { /* pass */ }
                  break;
                case CompletionContextKind.FunctionCall: {
                  // TODO: Promote functions with a return-type
                  // of our current function argument
                  // and local variables with either the correct type
                  // or are pointers to structs 
                  // (otherwise we have to do a search and deal with cycles)
                  break;
                }
              }
            }
          }

          for (const [name, type] of searchResult.environment) {
            locals.push({
              label: name,
              kind: CompletionItemKind.Variable,
              documentation: mkMarkdownCode(`${typeToString(type)} ${name}`),
              detail: uriToWorkspace(decl.loc?.source || undefined)
            });
          }
          break;
        }
      }
    }
  }

  // Don't include keywords since that corrupts the list
  // FIXME: we can just use "sortText" to move them
  // to the end of the completion list. But we then
  // have to implement sortText for everything it seems

  const completions = [...locals, ...functionDecls.values(), ...typedefs, ...fieldNames];

  return completions;
});

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => item);

connection.onHover((data: TextDocumentPositionParams): Hover | null => {
  const genv = openFiles.get(data.textDocument.uri);
  // Indicates no successful parse so far
  if (genv === undefined) { return null; }

  // Note that VSCode 0-indexes positions,
  // so to be compatible with nearley we must
  // add 1
  const hoverPos: ast.Position = ast.fromVscodePosition(data.position);

  const searchResult = findGenv({ pos: hoverPos, genv: genv }, data.textDocument.uri);

  if (searchResult === null || searchResult.data === null) return null;

  switch (searchResult.data.tag) {
    case "FoundIdent": {
      const { name, type } = searchResult.data;
      if (type.tag === "FunctionType") {
        // Also display contracts in hover result for a function 
        const decl = getFunctionDeclaration(genv, name);
        if (decl === null) return null; 
        const requires = decl.preconditions.map(precond =>
          `//@requires ${expressionToString(precond)}`);
        const ensures = decl.postconditions.map(postcond =>
          `//@ensures ${expressionToString(postcond)}`);

        return {
          contents: mkMarkdownCode(`${[typeToString({ tag: "FunctionType", definition: decl }), ...requires, ...ensures].join("\n")}`)
        };
      }
      else {
        return {
          contents: mkMarkdownCode(`${typeToString(type)} ${name}`)
        };
      }
    }
    case "FoundType": {
      const { type } = searchResult.data;
      const realType = actualType(genv, type);

      // Display as typedef if custom type
      if (type.tag === "Identifier") {
        return {
          contents: mkMarkdownCode(`typedef ${typeToString(realType)} ${type.name}`)
        };
      }

      return {
        contents: mkMarkdownCode(typeToString(realType))
      };
    }
    case "FoundField": {
      const { field, expression } = searchResult.data;

      return {
        contents: mkMarkdownCode(`${typeToString(field.kind)} ${expression}`)
      };
    }
  }
});

connection.onDefinition((data: TextDocumentPositionParams): LocationLink[] | null => {
  function toLocationLink(loc: ast.SourceLocation, origin?: ast.SourceLocation | undefined): LocationLink[] | null {
    return [{
      targetUri: loc.source || data.textDocument.uri,
      targetSelectionRange: {
        start: ast.toVscodePosition(loc.start),
        end: ast.toVscodePosition(loc.end)
      },
      targetRange: {
        start: ast.toVscodePosition(loc.start),
        end: ast.toVscodePosition(loc.end)
      },
      originSelectionRange: origin === undefined ? undefined : {
        start: ast.toVscodePosition(origin.start),
        end: ast.toVscodePosition(origin.end)
      }
    }];
  }

  const genv = openFiles.get(data.textDocument.uri);
  // Indicates no successful parse so far
  if (genv === undefined) { return null; }

  const pos: ast.Position = ast.fromVscodePosition(data.position);
  const searchResult = findGenv({ pos, genv }, data.textDocument.uri);

  // This indicates that the user hovered over something that
  // wasn't an indentifier
  if (searchResult === null || searchResult.data === null) return null;

  switch (searchResult.data.tag) {
    case "FoundType": {
      const { type } = searchResult.data;

      switch (type.tag) {
        case "Identifier":
          // Find a typedef with this tag
          const typedef = getTypedefDefinition(genv, type.name);
          if (typedef !== null && typedef.loc) {
            return toLocationLink(typedef.loc);
          }
          break;

        case "StructType":
          const struct = getStructDefinition(genv, type.id.name);
          if (struct !== null && struct.loc) {
            return toLocationLink(struct.loc, type.loc);
          }
          break;
      }
      break;
    }
    case "FoundIdent": {
      const { name, type } = searchResult.data;

      if (type.tag === "FunctionType") {
        // Look up function
        // TODO: suggest both the function declaration and the function definition
        const func = getFunctionDeclaration(genv, name);
        if (func && func.loc) {
          return toLocationLink(func.loc);
        }
      }
      const definition: EnvEntry | undefined = searchResult.environment?.get(name);

      if (definition === undefined || definition.position === undefined) return null;

      return toLocationLink(definition.position);
    }
    case "FoundField": {
      const { field } = searchResult.data;

      if (field.id.loc === undefined) return null;
      return toLocationLink(field.id.loc);
    }
  }

  return null;
});

connection.onSignatureHelp((data) => {
  const genv = openFiles.get(data.textDocument.uri);
  if (genv === undefined) { return null; }

  const doc = documents.get(data.textDocument.uri);
  if (!doc) return null;

  // Subtract one from the offset because 
  // data.position is the character right after
  // the opening paren or comma, which we want to ignore 
  const context = getCompletionContext(
    doc.getText(),
    doc.offsetAt(data.position) - 1);

  if (context && context.tag === CompletionContextKind.FunctionCall) {
    const functionDecl = getFunctionDeclaration(genv, context.name);
    if (!functionDecl) return null;

    let signature = `${typeToString(functionDecl.returns)} ${functionDecl.id.name}(`;
    let signatureLength = signature.length;

    const paramInfo: ParameterInformation[] = [];

    for (let i = 0; i < functionDecl.params.length; i++) {
      const param = functionDecl.params[i];

      const paramText = `${typeToString(param.kind)} ${param.id.name}`;
      paramInfo.push(ParameterInformation.create([signatureLength, signatureLength + paramText.length]));

      signature += paramText;
      signatureLength += paramText.length;

      if (i !== functionDecl.params.length - 1) {
        signature += ", ";
        signatureLength += 2;
      }
    }
    
    signature += ")";

    const sig = SignatureInformation.create(signature, undefined, ...paramInfo);

    return {
      signatures: [sig], // Functions only have one signature ever in C0
      activeSignature: 0,
      activeParameter: context.argumentNumber
    };
  }
});

connection.onDocumentFormatting((data: DocumentFormattingParams): TextEdit[] | null => {
  const doc = documents.get(data.textDocument.uri);
  if (!doc) return null;

  let indentLevel = 0;
  const indentChar = data.options.insertSpaces ? ' '.repeat(data.options.tabSize) : '\t';
  const edits: TextEdit[] = [];
  for (const [lineNum, line] of doc.getText().split("\n").entries()) {
      const lineLen = line.length;
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith("}")) {
          --indentLevel;
      }
      edits.push({
          range: { 
              start: { line: lineNum, character: 0 }, 
              end: { line: lineNum, character: lineLen }
          },
          newText: `${indentChar.repeat(indentLevel)}${trimmedLine}`
      });
      if (trimmedLine.endsWith("{")) {
          ++indentLevel;
      }
  }
  return edits;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

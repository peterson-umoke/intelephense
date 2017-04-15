/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { ParsedDocument, ParsedDocumentStore, ParsedDocumentChangeEventArgs } from './parsedDocument';
import { SymbolStore, SymbolTable } from './symbol';
import { SymbolProvider } from './symbolProvider';
import { CompletionProvider } from './completionProvider';
import { DiagnosticsProvider, PublishDiagnosticsEventArgs } from './diagnosticsProvider';
import { Debounce, Unsubscribe } from './types';
import { SignatureHelpProvider } from './signatureHelpProvider';
import { DefinitionProvider } from './definitionProvider';
import * as lsp from 'vscode-languageserver-types';

export namespace Intelephense {

    const phpLanguageId = 'php';

    let documentStore: ParsedDocumentStore;
    let symbolStore: SymbolStore;
    let symbolProvider: SymbolProvider;
    let completionProvider: CompletionProvider;
    let diagnosticsProvider: DiagnosticsProvider;
    let signatureHelpProvider: SignatureHelpProvider;
    let definitionProvider: DefinitionProvider;
    let unsubscribeMap: { [index: string]: Unsubscribe };

    function unsubscribe(key: string) {
        if (typeof unsubscribeMap[key] === 'function') {
            unsubscribe[key]();
            delete unsubscribeMap[key];
        }
    }

    export function onDiagnosticsStart(fn: (uri: string) => void) {
        const key = 'diagnosticsStart';
        unsubscribe(key);

        if (fn) {
            unsubscribeMap[key] = diagnosticsProvider.startDiagnosticsEvent.subscribe(fn);
        }
    }

    export function onPublishDiagnostics(fn: (args: PublishDiagnosticsEventArgs) => void) {
        const key = 'publishDiagnostics';
        unsubscribe(key);

        if (fn) {
            unsubscribeMap[key] = diagnosticsProvider.publishDiagnosticsEvent.subscribe(fn);
        }
    }

    export function initialise() {

        unsubscribeMap = {};
        documentStore = new ParsedDocumentStore();
        symbolStore = new SymbolStore();
        symbolProvider = new SymbolProvider(symbolStore);
        completionProvider = new CompletionProvider(symbolStore, documentStore);
        diagnosticsProvider = new DiagnosticsProvider();
        signatureHelpProvider = new SignatureHelpProvider(symbolStore, documentStore);
        definitionProvider = new DefinitionProvider(symbolStore, documentStore);
        unsubscribeMap['documentChange'] = documentStore.parsedDocumentChangeEvent.subscribe(symbolStore.onParsedDocumentChange);
        symbolStore.add(SymbolTable.createBuiltIn());

    }

    export function setDiagnosticsProviderDebounce(value:number){
        diagnosticsProvider.debounceWait = value;
    }

    export function setDiagnosticsProviderMaxItems(value:number){
        diagnosticsProvider.maxItems = value;
    }

    export function setCompletionProviderMaxItems(value:number){
        completionProvider.maxItems = value;
    }

    export function openDocument(textDocument: lsp.TextDocumentItem) {

        if (textDocument.languageId !== phpLanguageId || documentStore.has(textDocument.uri)) {
            return;
        }

        let parsedDocument = new ParsedDocument(textDocument.uri, textDocument.text);
        documentStore.add(parsedDocument);
        let symbolTable = SymbolTable.create(parsedDocument);
        //must remove before adding as entry may exist already from workspace discovery
        symbolStore.remove(symbolTable.uri);
        symbolStore.add(symbolTable);
        diagnosticsProvider.add(parsedDocument);

    }

    export function closeDocument(textDocument: lsp.TextDocumentIdentifier) {
        documentStore.remove(textDocument.uri);
        diagnosticsProvider.remove(textDocument.uri);
    }

    export function editDocument(
        textDocument: lsp.VersionedTextDocumentIdentifier,
        contentChanges: lsp.TextDocumentContentChangeEvent[]) {

        let parsedDocument = documentStore.find(textDocument.uri);
        if (parsedDocument) {
            parsedDocument.applyChanges(contentChanges);
        }

    }

    export function documentSymbols(textDocument: lsp.TextDocumentIdentifier) {
        flushParseDebounce(textDocument.uri);
        return symbolProvider.provideDocumentSymbols(textDocument.uri);
    }

    export function workspaceSymbols(query: string) {
        return query ? symbolProvider.provideWorkspaceSymbols(query) : [];
    }

    export function provideCompletions(textDocument: lsp.TextDocumentIdentifier, position: lsp.Position) {
        flushParseDebounce(textDocument.uri);
        return completionProvider.provideCompletions(textDocument.uri, position);
    }

    export function provideSignatureHelp(textDocument: lsp.TextDocumentIdentifier, position: lsp.Position) {
        flushParseDebounce(textDocument.uri);
        return signatureHelpProvider.provideSignatureHelp(textDocument.uri, position);
    }

    export function provideDefinition(textDocument: lsp.TextDocumentIdentifier, position: lsp.Position) {
        flushParseDebounce(textDocument.uri);
        return definitionProvider.provideDefinition(textDocument.uri, position);
    }

    export function discover(textDocument: lsp.TextDocumentItem) {

        let uri = textDocument.uri;

        if (documentStore.has(uri)) {
            //if document is in doc store/opened then dont rediscover.
            let symbolTable = symbolStore.getSymbolTable(uri);
            return symbolTable ? symbolTable.count : 0;
        }

        let text = textDocument.text;
        let parsedDocument = new ParsedDocument(uri, text);
        let symbolTable = SymbolTable.create(parsedDocument);
        symbolStore.remove(uri);
        symbolStore.add(symbolTable);
        return symbolTable.count;

    }

    export function forget(uri: string): number {
        let forgotten = 0;
        let table = symbolStore.getSymbolTable(uri);
        if (!table || documentStore.has(uri)) {
            return forgotten;
        }

        forgotten = table.count;
        symbolStore.remove(table.uri);
        return forgotten;
    }

    export function numberDocumentsOpen() {
        return documentStore.count;
    }

    export function numberDocumentsKnown() {
        return symbolStore.tableCount;
    }

    export function numberSymbolsKnown() {
        return symbolStore.symbolCount;
    }

    function flushParseDebounce(uri: string) {
        let parsedDocument = documentStore.find(uri);
        if (parsedDocument) {
            parsedDocument.flush();
        }
    }

}


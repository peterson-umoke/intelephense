/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import * as lsp from 'vscode-languageserver-types';
import { TreeVisitor } from './types'
import { Phrase, Token, PhraseType, TokenType } from 'php7parser';
import { ParsedDocument, ParsedDocumentStore } from './parsedDocument';

interface FormatRule {
    (previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit;
}

export class FormatProvider {

    constructor(public docStore: ParsedDocumentStore) { }

    provideDocumentFormattingEdits(doc: lsp.TextDocumentIdentifier, formatOptions: lsp.FormattingOptions) : lsp.TextEdit[] {

        let parsedDoc = this.docStore.find(doc.uri);

        if(!parsedDoc){
            return [];
        }

        let visitor = new FormatVisitor(parsedDoc, formatOptions);
        parsedDoc.traverse(visitor);
        return visitor.edits;

    }

}

class FormatVisitor implements TreeVisitor<Phrase | Token> {

    private _edits: lsp.TextEdit[];
    private _previousToken: Token;
    private _nextFormatRule: FormatRule;
    private _isMultilineCommaDelimitedListStack: boolean[];
    private _indentUnit: string;
    private _indentText = '';

    constructor(
        public doc: ParsedDocument,
        public formatOptions: lsp.FormattingOptions) {
        this._edits = [];
        this._isMultilineCommaDelimitedListStack = [];
        this._indentUnit = formatOptions.insertSpaces ? FormatVisitor.createWhitespace(formatOptions.tabSize, ' ') : '\t';
    }

    get edits() {
        return this._edits.reverse();
    }

    preorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        let parent = spine[spine.length - 1] as Phrase;

        switch ((<Phrase>node).phraseType) {

            //newline indent before {
            case PhraseType.FunctionDeclarationBody:
                if (parent.phraseType === PhraseType.AnonymousFunctionCreationExpression) {
                    return true;
                }
            // fall through
            case PhraseType.MethodDeclarationBody:
            case PhraseType.ClassDeclarationBody:
            case PhraseType.TraitDeclarationBody:
            case PhraseType.InterfaceDeclarationBody:
                this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                return true;

            //comma delim lists
            case PhraseType.QualifiedNameList:
            case PhraseType.ClassConstElementList:
            case PhraseType.ConstElementList:
            case PhraseType.PropertyElementList:
                this._incrementIndent();
                if (
                    (this._previousToken &&
                        this._previousToken.tokenType === TokenType.Whitespace &&
                        FormatVisitor.countNewlines(this.doc.tokenText(this._previousToken)) > 0) ||
                    this._hasNewlineWhitespaceChild(<Phrase>node)
                ) {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    this._isMultilineCommaDelimitedListStack.push(true);
                } else {
                    this._isMultilineCommaDelimitedListStack.push(false);
                }
                return true;

            //comma delim lists inside parentheses
            case PhraseType.ParameterDeclarationList:
            case PhraseType.ArgumentExpressionList:
            case PhraseType.ClosureUseList:
            case PhraseType.ArrayInitialiserList:
                this._incrementIndent();
                if (
                    (this._previousToken &&
                        this._previousToken.tokenType === TokenType.Whitespace &&
                        FormatVisitor.countNewlines(this.doc.tokenText(this._previousToken)) > 0) ||
                    this._hasNewlineWhitespaceChild(<Phrase>node)
                ) {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    this._isMultilineCommaDelimitedListStack.push(true);
                } else {
                    this._isMultilineCommaDelimitedListStack.push(false);
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                return true;

            case PhraseType.EncapsulatedVariableList:
                this._nextFormatRule = FormatVisitor.noSpaceBefore;
                return true;

            case undefined:
                //tokens
                break;
            default:
                return true;
        }

        let rule = this._nextFormatRule;
        let previous = this._previousToken;
        this._previousToken = node as Token;
        this._nextFormatRule = null;

        if(!previous){
            return false;
        }

        switch ((<Token>node).tokenType) {

            case TokenType.Whitespace:
                this._nextFormatRule = rule;
                return false;

            case TokenType.Comment:

                this._nextFormatRule = rule;
                break;

            case TokenType.DocumentComment:
                rule = FormatVisitor.newlineIndentBefore;
                break;

            case TokenType.PlusPlus:
                if(parent.phraseType === PhraseType.PostfixIncrementExpression){
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenType.MinusMinus:
                if(parent.phraseType === PhraseType.PostfixDecrementExpression){
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenType.Semicolon:
            case TokenType.Comma:
                rule = FormatVisitor.noSpaceBefore;
                break;

            case TokenType.Arrow:
            case TokenType.ColonColon:
                rule = FormatVisitor.noSpaceOrNewlineIndentPlusOneBefore;
                break;

            case TokenType.OpenParenthesis:
                if (this._shouldOpenParenthesisHaveNoSpaceBefore(parent)) {
                    rule = FormatVisitor.noSpaceBefore;
                } else {
                    rule = FormatVisitor.singleSpaceBefore;
                }
                break;

            case TokenType.OpenBracket:
                if (parent.phraseType === PhraseType.SubscriptExpression) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenType.CloseBrace:
                this._decrementIndent();
                if (
                    parent.phraseType === PhraseType.SubscriptExpression ||
                    parent.phraseType === PhraseType.EncapsulatedExpression ||
                    parent.phraseType === PhraseType.EncapsulatedVariable
                ) {
                    rule = FormatVisitor.noSpaceBefore;
                } else {
                    rule = FormatVisitor.newlineIndentBefore;
                }
                break;

            case TokenType.CloseBracket:
            case TokenType.CloseParenthesis:
                if (!rule) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenType.EncapsulatedAndWhitespace:
            case TokenType.VariableName:
            case TokenType.DollarCurlyOpen:
            case TokenType.CurlyOpen:
                if(parent.phraseType === PhraseType.EncapsulatedVariableList){
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            default:
                break;
        }

        if (!rule) {
            rule = FormatVisitor.singleSpaceOrNewlineIndentPlusOneBefore;
        }

        let edit = rule(previous, this.doc, this._indentText, this._indentUnit);
        if (edit) {
            this._edits.push(edit);
        }
        return false;
    }

    postorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        let parent = spine[spine.length - 1] as Phrase;

        switch ((<Phrase>node).phraseType) {
            case PhraseType.CaseStatement:
            case PhraseType.DefaultStatement:
                this._decrementIndent();
                return;

            case PhraseType.NamespaceDefinition:
                this._nextFormatRule = FormatVisitor.doubleNewlineIndentBefore;
                return;

            case PhraseType.NamespaceUseDeclaration:
                if (this._isLastNamespaceUseDeclaration(parent, <Phrase>node)) {
                    this._nextFormatRule = FormatVisitor.doubleNewlineIndentBefore;
                }
                return;

            case PhraseType.ParameterDeclarationList:
            case PhraseType.ArgumentExpressionList:
            case PhraseType.ClosureUseList:
            case PhraseType.QualifiedNameList:
            case PhraseType.ArrayInitialiserList:
                if (this._isMultilineCommaDelimitedListStack.pop()) {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }
                return;

            case PhraseType.ClassConstElementList:
            case PhraseType.ConstElementList:
            case PhraseType.PropertyElementList:
                this._isMultilineCommaDelimitedListStack.pop();
                return;

            case PhraseType.EncapsulatedVariableList:
                this._nextFormatRule = FormatVisitor.noSpaceBefore;
                return;

            case undefined:
                //tokens
                break;

            default:
                return;
        }

        switch ((<Token>node).tokenType) {

            case TokenType.DocumentComment:
                this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                break;

            case TokenType.OpenBrace:
                if (parent.phraseType === PhraseType.EncapsulatedExpression) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                } else {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }

                this._incrementIndent();
                break;

            case TokenType.CloseBrace:
                if (parent.phraseType !== PhraseType.EncapsulatedVariable &&
                    parent.phraseType !== PhraseType.EncapsulatedExpression &&
                    parent.phraseType !== PhraseType.SubscriptExpression
                ) {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }
                break;

            case TokenType.Semicolon:
                this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                break;

            case TokenType.Colon:
                if (this._shouldIndentAfterColon(<Phrase>spine[spine.length - 1])) {
                    this._incrementIndent();
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }

                break;

            case TokenType.Ampersand:
                if (parent.phraseType !== PhraseType.BitwiseExpression) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenType.Plus:
            case TokenType.Minus:
                if (parent.phraseType === PhraseType.UnaryOpExpression) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenType.PlusPlus:
                if (parent.phraseType === PhraseType.PrefixIncrementExpression) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenType.MinusMinus:
                if (parent.phraseType === PhraseType.PrefixDecrementExpression) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenType.Ellipsis:
            case TokenType.Exclamation:
            case TokenType.AtSymbol:
            case TokenType.ArrayCast:
            case TokenType.BooleanCast:
            case TokenType.FloatCast:
            case TokenType.IntegerCast:
            case TokenType.ObjectCast:
            case TokenType.StringCast:
            case TokenType.UnsetCast:
            case TokenType.Tilde:
            case TokenType.Backslash:
            case TokenType.OpenParenthesis:
            case TokenType.OpenBracket:
                this._nextFormatRule = FormatVisitor.noSpaceBefore;
                break;

            case TokenType.Comma:
                if (parent.phraseType === PhraseType.ArrayInitialiserList) {
                    this._nextFormatRule = FormatVisitor.singleSpaceOrNewlineIndentBefore;
                } else if (
                    this._isMultilineCommaDelimitedListStack.length > 0 &&
                    this._isMultilineCommaDelimitedListStack[this._isMultilineCommaDelimitedListStack.length - 1]
                ) {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                } else {
                    this._nextFormatRule = FormatVisitor.singleSpaceBefore;
                }
                break;

            default:
                break;

        }

    }

    private _incrementIndent() {
        this._indentText += this._indentUnit;
    }

    private _decrementIndent() {
        this._indentText = this._indentText.slice(0, -this._indentUnit.length);
    }

    private _hasNewlineWhitespaceChild(phrase: Phrase) {
        for (let n = 0, l = phrase.children.length; n < l; ++n) {
            if (
                (<Token>phrase.children[n]).tokenType === TokenType.Whitespace &&
                FormatVisitor.countNewlines(this.doc.tokenText(<Token>phrase.children[n])) > 0
            ) {
                return true;
            }
        }
        return false;
    }

    private _isLastNamespaceUseDeclaration(parent: Phrase, child: Phrase) {

        let i = parent.children.indexOf(child);
        while (i < parent.children.length) {
            ++i;
            child = parent.children[i] as Phrase;
            if (child.phraseType) {
                return child.phraseType !== PhraseType.NamespaceUseDeclaration;
            }
        }

        return true;

    }

    private _shouldIndentAfterColon(parent: Phrase) {
        switch (parent.phraseType) {
            case PhraseType.CaseStatement:
            case PhraseType.DefaultStatement:
                return true;
            default:
                return false;
        }
    }

    private _shouldOpenParenthesisHaveNoSpaceBefore(parent: Phrase) {
        switch (parent.phraseType) {
            case PhraseType.FunctionCallExpression:
            case PhraseType.MethodCallExpression:
            case PhraseType.ScopedCallExpression:
            case PhraseType.EchoIntrinsic:
            case PhraseType.EmptyIntrinsic:
            case PhraseType.EvalIntrinsic:
            case PhraseType.ExitIntrinsic:
            case PhraseType.IssetIntrinsic:
            case PhraseType.ListIntrinsic:
            case PhraseType.PrintIntrinsic:
            case PhraseType.UnsetIntrinsic:
            case PhraseType.ArrayCreationExpression:
                return true;
            default:
                return false;
        }
    }

    private _hasColonChild(phrase: Phrase) {

        for (let n = 0, l = phrase.children.length; n < l; ++n) {
            if ((<Token>phrase.children[n]).tokenType === TokenType.Colon) {
                return true;
            }
        }
        return false;

    }

}

namespace FormatVisitor {

    export function singleSpaceBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.tokenType !== TokenType.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), ' ');
        }

        let actualWs = doc.tokenText(previous);
        let expectedWs = ' ';
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
    }

    export function newlineIndentBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.tokenType !== TokenType.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), '\n' + indentText);
        }

        let actualWs = doc.tokenText(previous);
        let expectedWs = createWhitespace(Math.max(1, countNewlines(actualWs)), '\n') + indentText;
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
    }

    export function newlineIndentPlusOneBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.tokenType !== TokenType.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), '\n' + indentText + indentUnit);
        }

        let actualWs = doc.tokenText(previous);
        let expectedWs = createWhitespace(Math.max(1, countNewlines(actualWs)), '\n') + indentText + indentUnit;
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
    }

    export function doubleNewlineIndentBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.tokenType !== TokenType.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), '\n\n' + indentText);
        }

        let actualWs = doc.tokenText(previous);
        let expected = createWhitespace(Math.max(2, countNewlines(actualWs)), '\n') + indentText;
        if (actualWs === expected) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expected);
    }

    export function noSpaceBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.tokenType !== TokenType.Whitespace) {
            return null;
        }
        return lsp.TextEdit.del(doc.tokenRange(previous));
    }

    export function noSpaceOrNewlineIndentBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.tokenType !== TokenType.Whitespace) {
            return null;
        }

        let actualWs = doc.tokenText(previous);
        let newlineCount = countNewlines(actualWs);
        if (!newlineCount) {
            return lsp.TextEdit.del(doc.tokenRange(previous));
        }

        let expectedWs = createWhitespace(newlineCount, '\n') + indentText;
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);

    }

    export function noSpaceOrNewlineIndentPlusOneBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.tokenType !== TokenType.Whitespace) {
            return null;
        }

        let actualWs = doc.tokenText(previous);
        let newlineCount = countNewlines(actualWs);
        if (!newlineCount) {
            return lsp.TextEdit.del(doc.tokenRange(previous));
        }

        let expectedWs = createWhitespace(newlineCount, '\n') + indentText + indentUnit;
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);

    }

    export function singleSpaceOrNewlineIndentPlusOneBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {

        if (previous.tokenType !== TokenType.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), ' ');
        }

        let actualWs = doc.tokenText(previous);
        if (actualWs === ' ') {
            return null;
        }

        let newlineCount = countNewlines(actualWs);
        if (!newlineCount) {
            return lsp.TextEdit.replace(doc.tokenRange(previous), ' ');
        }

        let expectedWs = createWhitespace(newlineCount, '\n') + indentText + indentUnit;
        if (actualWs !== expectedWs) {
            return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
        }

        return null;

    }

    export function singleSpaceOrNewlineIndentBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {

        if (previous.tokenType !== TokenType.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), ' ');
        }

        let actualWs = doc.tokenText(previous);
        if (actualWs === ' ') {
            return null;
        }

        let newlineCount = countNewlines(actualWs);
        if (!newlineCount) {
            return lsp.TextEdit.replace(doc.tokenRange(previous), ' ');
        }

        let expectedWs = createWhitespace(newlineCount, '\n') + indentText;
        if (actualWs !== expectedWs) {
            return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
        }

        return null;

    }

    export function createWhitespace(n: number, unit: string) {
        let text = '';
        while (n > 0) {
            text += unit;
            --n;
        }
        return text;
    }

    export function countNewlines(text: string) {

        let c: string;
        let count = 0;
        let l = text.length;
        let n = 0;

        while (n < l) {
            c = text[n];
            ++n;
            if (c === '\r') {
                ++count;
                if (n < l && text[n] === '\n') {
                    ++n;
                }
            } else if (c === '\n') {
                ++count;
            }

        }

        return count;

    }

}
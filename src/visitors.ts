/* Copyright © Ben Mewburn ben@mewburn.id.au
 * Licensed under the MIT Licence.
 */

'use strict';

import { Position, Range, Predicate, Tree, TreeVisitor, BinarySearch, SuffixArray } from './types';
import { NonTerminal, NonTerminalType, NonTerminalFlag, Token } from 'php7parser';
import { PhpDocParser, PhpDoc, Tag, MethodTagParam, TypeTag, MethodTag } from './parse';
import * as util from './util';
import {
    PhpSymbol, NameResolver, ImportRule, ImportTable, SymbolKind, TypeString, SymbolModifier,
    SymbolTree, ResolvedVariableTable
} from './symbol';

export class ImportTableReader implements TreeVisitor<NonTerminal | Token> {

    private _stack: any[];
    private _active: number;

    constructor(public importTable: ImportTable) {
        this._stack = [];
        this._active = 0;
    }

    preOrder(node: Tree<NonTerminal | Token>) {

        if (node.value === null) {
            return;
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.UseStatement:
            case NonTerminalType.UseGroup:
                ++this._active;
                break;
            default:
                break;
        }

    }

    postOrder(node: Tree<NonTerminal | Token>) {

        if (this._active < 1) {
            return;
        }

        if (!node.value) {
            this._stack.push(null);
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.NamespaceName:
                this._stack.push(util.popMany(this._stack, node.children.length).join('\\'));
                break;
            case NonTerminalType.UseElement:
                this._postOrderUseElement(<Tree<NonTerminal>>node);
                break;
            case NonTerminalType.UseList:
                this._postOrderUseList(<Tree<NonTerminal>>node);
                break;
            case NonTerminalType.UseStatement:
                this._postOrderUseStatement(<Tree<NonTerminal>>node);
                --this._active;
                break;
            case NonTerminalType.UseGroup:
                this._postOrderUseGroup(<Tree<NonTerminal>>node);
                --this._active;
                break;
            case undefined:
                //Token
                this._stack.push((<Token>node.value).text);
            default:
                break;
        }
    }

    shouldDescend(node: Tree<NonTerminal | Token>) {


        if (node.value === null) {
            return false;
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.TopStatementList:
            case NonTerminalType.UseElement:
            case NonTerminalType.UseList:
            case NonTerminalType.UseStatement:
            case NonTerminalType.UseGroup:
            case NonTerminalType.NamespaceName:
            case NonTerminalType.Namespace:
                return true;
            default:
                return false;
        }
    }

    private _postOrderUseGroup(node: Tree<NonTerminal>) {
        let prefix: string, list: ImportRule[];
        let kind = this._useFlagToSymbolKind(node.value.flag);
        [prefix, list] = util.popMany(this._stack, 2);
        let rule: ImportRule;

        for (let n = 0; n < list.length; ++n) {
            rule = list[n];
            if (prefix) {
                rule.fqn = prefix + '\\' + rule.fqn;
            }
            if (kind) {
                rule.kind = kind;
            }
        }
        this.importTable.addRuleMany(list);
    }

    private _postOrderUseStatement(node: Tree<NonTerminal>) {
        let list = this._stack.pop() as ImportRule[];
        let kind = this._useFlagToSymbolKind(node.value.flag);
        for (let n = 0; n < list.length; ++n) {
            list[n].kind = kind;
        }
        this.importTable.addRuleMany(list);
    }

    private _postOrderUseList(node: Tree<NonTerminal>) {
        this._stack.push(util.popMany(this._stack, node.children.length).filter((v, i, a) => { return v; }));
    }

    private _postOrderUseElement(node: Tree<NonTerminal>) {
        let fqn: string, name: string;
        [fqn, name] = util.popMany(this._stack, 2);
        if (fqn) {
            this._stack.push({
                kind: this._useFlagToSymbolKind(node.value.flag),
                fqn: fqn,
                name: name
            });
        } else {
            this._stack.push(null);
        }
    }

    private _useFlagToSymbolKind(flag: NonTerminalFlag) {
        switch (flag) {
            case NonTerminalFlag.UseClass:
                return SymbolKind.Class;
            case NonTerminalFlag.UseConstant:
                return SymbolKind.Constant;
            case NonTerminalFlag.UseFunction:
                return SymbolKind.Function;
            default:
                return 0;
        }
    }

}

export class NamespaceReader implements TreeVisitor<NonTerminal | Token> {

    private _stack: any[];
    private _active: number;

    constructor(public nameResolver: NameResolver) {
        this._stack = [];
        this._active = 0;
    }

    preOrder(node: Tree<NonTerminal | Token>) {
        if (node.value !== null && (<NonTerminal>node.value).nonTerminalType === NonTerminalType.Namespace) {
            ++this._active;
        }
    }

    inOrder(node: Tree<NonTerminal | Token>, afterChildIndex) {
        if (node.value !== null && (<NonTerminal>node.value).nonTerminalType === NonTerminalType.Namespace && afterChildIndex === 0) {
            this.nameResolver.namespace = util.top(this._stack);
        }
    }

    postOrder(node: Tree<NonTerminal | Token>) {

        if (this._active < 1) {
            return;
        }

        if (node.value === null) {
            this._stack.push(null);
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.NamespaceName:
                this._stack.push(util.popMany(this._stack, node.children.length).join('\\'));
                break;
            case NonTerminalType.Namespace:
                let name: string, list: boolean;
                [name, list] = util.popMany(this._stack, 2);
                if (name && list) {
                    this.nameResolver.namespace = '';
                }
                --this._active;
                break;
            case NonTerminalType.TopStatementList:
                this._stack.push(true);
                break;
            case undefined:
                //Token
                this._stack.push((<Token>node.value).text);
            default:
                break;

        }

    }

    shouldDescend(node: Tree<NonTerminal | Token>) {

        if (node.value === null) {
            return false;
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.TopStatementList:
                return this._active < 1;
            case NonTerminalType.Namespace:
            case NonTerminalType.NamespaceName:
                return true;
            default:
                return false;
        }
    }

}

export class SymbolReader implements TreeVisitor<NonTerminal | Token> {

    private _stack: any[];
    private _active: number;

    constructor(public uri: string, public importTable: ImportTable,
        public nameResolver: NameResolver, public docBlockParser: PhpDocParser,
        public symbolTreeRoot: SymbolTree) {
        this._stack = [];
        this._active = 0;
    }

    preOrder(node: Tree<NonTerminal | Token>) {

        if (node.value === null) {
            return;
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.Namespace:
            case NonTerminalType.FunctionDeclaration:
            case NonTerminalType.ClassDeclaration:
            case NonTerminalType.TraitDeclaration:
            case NonTerminalType.InterfaceDeclaration:
            case NonTerminalType.ConstantDeclarationList:
                ++this._active;
                break;
            default:
                break;
        }

    }

    postOrder(node: Tree<NonTerminal | Token>) {

        if (this._active < 1) {
            return;
        }

        if (node.value === null) {
            this._stack.push(null);
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.NamespaceName:
                this._stack.push(util.popMany(this._stack, node.children.length).join('\\'));
                break;
            case NonTerminalType.Namespace:
                this._postOrderNamespace(<Tree<NonTerminal>>node);
                --this._active;
                break;
            case NonTerminalType.Name:
                this._postOrderName(<Tree<NonTerminal>>node);
                break;
            case NonTerminalType.NameList:
                this._stack.push(this._filterNull(util.popMany(this._stack, node.children.length)));
                break;
            case NonTerminalType.FunctionDeclaration:
                this._postOrderFunctionDeclaration(<Tree<NonTerminal>>node);
                --this._active;
                break;
            case NonTerminalType.ClassDeclaration:
                this._postOrderClassDeclaration(<Tree<NonTerminal>>node);
                --this._active;
                break;
            case NonTerminalType.TraitDeclaration:
                this._postOrderTraitDeclaration(<Tree<NonTerminal>>node);
                --this._active;
                break;
            case NonTerminalType.InterfaceDeclaration:
                this._postOrderInterfaceDeclaration(<Tree<NonTerminal>>node);
                --this._active;
                break;
            case NonTerminalType.ClassConstantDeclarationList:
            case NonTerminalType.PropertyDeclarationList:
                this._postOrderPropertyOrClassConstantDeclarationStatement(<Tree<NonTerminal>>node);
                break;
            case NonTerminalType.PropertyDeclaration:
                this._postOrderPropertyOrClassConstantDeclaration(<Tree<NonTerminal>>node, SymbolKind.Property);
                break;
            case NonTerminalType.ClassConstantDeclaration:
                this._postOrderPropertyOrClassConstantDeclaration(<Tree<NonTerminal>>node, SymbolKind.Constant);
                break;
            case NonTerminalType.ConstantDeclarationList:
                --this._active;
                break;
            case NonTerminalType.ConstantDeclaration:
                this._postOrderConstantDeclaration(<Tree<NonTerminal>>node);
                break;
            case NonTerminalType.MethodDeclaration:
                this._postOrderMethodDeclaration(<Tree<NonTerminal>>node);
                break;
            case NonTerminalType.ClassStatementList:
                this._stack.push(util.popMany(this._stack, node.children.length));
                break;
            case NonTerminalType.UseTrait:
                this._postOrderUseTrait(<Tree<NonTerminal>>node);
                break;
            case NonTerminalType.Parameter:
                this._postOrderParameter(<Tree<NonTerminal>>node);
                break;
            case NonTerminalType.ParameterList:
                this._stack.push(util.popMany(this._stack, node.children.length));
                break;
            case NonTerminalType.TypeExpression:
                //stack top should be string
                break;
            case undefined:
                //Token
                this._stack.push((<Token>node.value).text);
            default:
                this._stack.push(null);
                break;
        }

    }

    shouldDescend(node: Tree<NonTerminal | Token>) {

        if (!node.value) {
            return false;
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.Block:
            case NonTerminalType.Case:
            case NonTerminalType.CaseList:
            case NonTerminalType.Catch:
            case NonTerminalType.CatchList:
            case NonTerminalType.ClassConstantDeclaration:
            case NonTerminalType.ClassConstantDeclarationList:
            case NonTerminalType.ClassDeclaration:
            case NonTerminalType.ClassStatementList:
            case NonTerminalType.ConstantDeclaration:
            case NonTerminalType.ConstantDeclarationList:
            case NonTerminalType.DoWhile:
            case NonTerminalType.Finally:
            case NonTerminalType.For:
            case NonTerminalType.Foreach:
            case NonTerminalType.FunctionDeclaration:
            case NonTerminalType.If:
            case NonTerminalType.IfList:
            case NonTerminalType.InnerStatementList:
            case NonTerminalType.InterfaceDeclaration:
            case NonTerminalType.MethodDeclaration:
            case NonTerminalType.Name:
            case NonTerminalType.NameList:
            case NonTerminalType.Namespace:
            case NonTerminalType.NamespaceName:
            case NonTerminalType.Parameter:
            case NonTerminalType.ParameterList:
            case NonTerminalType.PropertyDeclaration:
            case NonTerminalType.PropertyDeclarationList:
            case NonTerminalType.Switch:
            case NonTerminalType.TopStatementList:
            case NonTerminalType.TraitDeclaration:
            case NonTerminalType.Try:
            case NonTerminalType.TypeExpression:
            case NonTerminalType.UseTrait:
            case NonTerminalType.While:
                return true;
            default:
                return false;
        }
    }

    private _postOrderUseTrait(node: Tree<NonTerminal>) {

        let nameList: string[], adaptationList: null;
        [nameList, adaptationList] = util.popMany(this._stack, 2);
        this._stack.push(nameList);

    }

    private _postOrderParameter(node: Tree<NonTerminal>) {

        let type: string, name: string, expr: null;
        [type, name, expr] = util.popMany(this._stack, 3);

        if (!name) {
            this._stack.push(null);
            return;
        }

        let s = new PhpSymbol(SymbolKind.Parameter, name);
        s.type = new TypeString(type);
        this._assignLocation(s, node.value);
        this._stack.push(new Tree<PhpSymbol>(s));

    }

    private _filterNull(array: any[]) {

        let filtered: any[] = [];
        for (let n = 0; n < array.length; ++n) {
            if (array[n] !== null) {
                filtered.push(array[n]);
            }
        }
        return filtered;
    }

    private _postOrderName(node: Tree<NonTerminal>) {
        let nsName = this._stack.pop() as string;

        if (!nsName) {
            this._stack.push(null);
            return;
        }

        switch (node.value.flag) {
            case NonTerminalFlag.NameFullyQualified:
                this._stack.push(nsName);
                break;
            case NonTerminalFlag.NameRelative:
                this._stack.push(this.nameResolver.resolveRelative(nsName));
                break;
            case NonTerminalFlag.NameNotFullyQualified:
                this._stack.push(this.nameResolver.resolveNotFullyQualified(nsName, SymbolKind.Class));
                break;
            default:
                break;
        }
    }

    private _postOrderInterfaceDeclaration(node: Tree<NonTerminal>) {

        let name: string, extendsList: string[], body: (Tree<PhpSymbol>[] | Tree<PhpSymbol> | string[])[];
        [name, extendsList, body] = util.popMany(this._stack, 3);
        if (!name) {
            return;
        }

        let s = new PhpSymbol(SymbolKind.Interface, this.nameResolver.resolveRelative(name));
        let t = new Tree<PhpSymbol>(s);
        this._assignLocation(s, node.value);
        this._assignClassBody(t, body);
        this._assignClassPhpDoc(t, node.value.doc);
        this.symbolTreeRoot.addChild(t);

    }

    private _postOrderTraitDeclaration(node: Tree<NonTerminal>) {

        let name: string, body: (Tree<PhpSymbol>[] | Tree<PhpSymbol> | string[])[];
        [name, body] = util.popMany(this._stack, 2);

        if (!name) {
            return;
        }

        let s = new PhpSymbol(SymbolKind.Trait, this.nameResolver.resolveRelative(name));
        let t = new Tree<PhpSymbol>(s);
        this._assignLocation(s, node.value);
        this._assignClassBody(t, body);
        this._assignClassPhpDoc(t, node.value.doc);
        this.symbolTreeRoot.addChild(t);

    }

    private _postOrderPropertyOrClassConstantDeclaration(node: Tree<NonTerminal>, kind: SymbolKind) {
        let name: string, value: string;
        [name, value] = util.popMany(this._stack, 2);

        if (!name) {
            this._stack.push(null);
            return;
        }

        let s = new PhpSymbol(kind, name);
        this._assignLocation(s, node.value);
        this._stack.push(new Tree<PhpSymbol>(s));
    }

    private _postOrderPropertyOrClassConstantDeclarationStatement(node: Tree<NonTerminal>) {

        let list = util.popMany(this._stack, node.children.length);
        let prop: Tree<PhpSymbol>;
        let modifiers = this._nonTerminalFlagToSymbolModifier(node.value.flag);
        let doc = node.value.doc ? this.docBlockParser.parse(node.value.doc.text) : null;
        let filtered: Tree<PhpSymbol>[] = [];

        for (let n = 0; n < list.length; ++n) {
            prop = list[n];
            if (!prop) {
                continue;
            }
            prop.value.modifiers = modifiers;
            this._assignPropertyPhpDoc(prop.value, doc);
            filtered.push(prop);
        }

        this._stack.push(filtered);

    }

    private _assignPropertyPhpDoc(s: PhpSymbol, doc: PhpDoc) {
        if (!doc) {
            return;
        }

        let tag: TypeTag;
        for (let n = 0; n < doc.tags.length; ++n) {
            tag = doc.tags[n] as TypeTag;
            if (tag.tagName === '@var' && (!tag.name || tag.name === s.name)) {
                s.description = tag.description;
                s.type = new TypeString(tag.typeString);
                break;
            }
        }

    }

    private _postOrderConstantDeclaration(node: Tree<NonTerminal>) {

        let name: string, value: string;
        [name, value] = util.popMany(this._stack, 2);
        if (!name) {
            this._stack.push(null);
            return;
        }
        name = this.nameResolver.resolveRelative(name);
        let s = new PhpSymbol(SymbolKind.Constant, name);
        this._assignLocation(s, node.value);
        this.symbolTreeRoot.addChild(new Tree<PhpSymbol>(s));

    }

    private _assignLocation(s: PhpSymbol, n: NonTerminal) {
        s.start = n.startToken.range.start.line;
        s.end = n.startToken.range.end.line;
        s.uri = this.uri;
    }

    private _assignClassBody(t: Tree<PhpSymbol>, body: (Tree<PhpSymbol> | Tree<PhpSymbol>[] | string[])[]) {

        if (!body) {
            return;
        }
        let child: Tree<PhpSymbol> | Tree<PhpSymbol>[] | string[];
        let gChild: Tree<PhpSymbol> | string;

        for (let n = 0; n < body.length; ++n) {
            child = body[n];

            if (Array.isArray(child)) {
                if (!child.length) {
                    continue;
                }

                if (util.isString(child[0])) {
                    //traits
                    if (!t.value.associated) {
                        t.value.associated = [];
                    }
                    Array.prototype.push.apply(t.value.associated, child);
                } else {
                    //constants, properties
                    for (let k = 0; k < child.length; ++k) {
                        gChild = child[k];
                        //property/constant
                        (<Tree<PhpSymbol>>gChild).value.scope = t.value.name;
                        t.addChild(<Tree<PhpSymbol>>gChild);
                    }
                }

            }
            else {
                //methods
                (<Tree<PhpSymbol>>child).value.scope = t.value.name;
                t.addChild(<Tree<PhpSymbol>>child);
            }
        }
    }

    private _assignClassPhpDoc(t: Tree<PhpSymbol>, doc: Token) {
        if (!doc) {
            return;
        }

        let phpDoc = this.docBlockParser.parse(doc.text);
        t.value.description = phpDoc.summary;
        this._addClassMagicMembers(t, phpDoc);

    }

    private _postOrderMethodDeclaration(node: Tree<NonTerminal>) {

        let name: string, params: Tree<PhpSymbol>[], returnType: string, body: null;
        [name, params, returnType, body] = util.popMany(this._stack, 4);

        if (!name) {
            this._stack.push(null);
            return;
        }

        let s = new PhpSymbol(SymbolKind.Method, name);
        s.modifiers = this._nonTerminalFlagToSymbolModifier(node.value.flag);

        if (returnType) {
            s.type = new TypeString(returnType);
        }

        let tree = new Tree<PhpSymbol>(s);
        this._assignFunctionOrMethodParameters(tree, params);
        this._assignFunctionOrMethodPhpDoc(s, params, node.value.doc);
        this._assignLocation(s, node.value);
        this._stack.push(tree);

    }

    private _postOrderFunctionDeclaration(node: Tree<NonTerminal>) {

        let name: string, params: Tree<PhpSymbol>[], returnType: string, body: null;
        [name, params, returnType, body] = util.popMany(this._stack, 4);

        if (!name) {
            return;
        }

        name = this.nameResolver.resolveRelative(name);
        let s = new PhpSymbol(SymbolKind.Function, name);

        if (returnType) {
            s.type = new TypeString(returnType);
        }

        let tree = new Tree<PhpSymbol>(s);
        this._assignFunctionOrMethodParameters(tree, params);
        this._assignFunctionOrMethodPhpDoc(s, params, node.value.doc);
        this._assignLocation(s, node.value);
        this.symbolTreeRoot.addChild(tree);

    }



    private _assignFunctionOrMethodParameters(s: Tree<PhpSymbol>, params: Tree<PhpSymbol>[]) {

        let param: Tree<PhpSymbol>;
        for (let n = 0; n < params.length; ++n) {
            param = params[n];
            if (!param) {
                continue;
            }
            param.value.scope = s.value.name;
            s.addChild(param);
        }

    }

    private _assignFunctionOrMethodPhpDoc(s: PhpSymbol, params: Tree<PhpSymbol>[], doc: Token) {

        let phpDoc: PhpDoc;
        if (!doc || !(phpDoc = this.docBlockParser.parse(doc.text))) {
            return;
        }

        s.description = phpDoc.summary;
        let tag: TypeTag;
        let paramMap: { [name: string]: PhpSymbol } = {};
        let param: PhpSymbol;

        for (let n = 0; n < params.length; ++n) {
            param = params[n].value;
            paramMap[param.name] = param;
        }

        for (let n = 0; n < phpDoc.tags.length; ++n) {
            tag = phpDoc.tags[n] as TypeTag;
            if (tag.tagName === '@param') {
                param = paramMap[tag.name];
                if (paramMap[tag.name]) {
                    param.description = tag.description;
                    param.type = param.type === undefined ? new TypeString(tag.typeString) : param.type.merge(tag.typeString);
                }
            } else if (tag.tagName === '@return') {
                s.type = s.type === undefined ? new TypeString(tag.typeString) : s.type.merge(tag.typeString);
            }
        }

    }

    private _postOrderNamespace(node: Tree<NonTerminal>) {
        let name: string, list: Tree<PhpSymbol>[];
        [name, list] = util.popMany(this._stack, 2);
        let nodes: Tree<PhpSymbol>[] = [];

        if (name) {
            let s = new PhpSymbol(SymbolKind.Namespace, name);
            s.start = s.end = node.value.startToken.range.start.line;
            s.uri = this.uri;
            this.symbolTreeRoot.addChild(new Tree<PhpSymbol>(s));
        }

    }

    private _postOrderClassDeclaration(node: Tree<NonTerminal>) {

        let name: string, extendsClass: string, implementsInterfaces: string[], body: (string[] | Tree<PhpSymbol>)[];
        [name, extendsClass, implementsInterfaces, body] = util.popMany(this._stack, 4);

        if (!name) {
            return;
        }

        name = this.nameResolver.resolveRelative(name);
        let s = new PhpSymbol(SymbolKind.Class, name);
        if (extendsClass || (implementsInterfaces && implementsInterfaces.length)) {
            s.associated = [];
            if (extendsClass) {
                s.associated.push(extendsClass);
            }
            if (implementsInterfaces) {
                Array.prototype.push.apply(s.associated, implementsInterfaces);
            }
        }

        s.modifiers = this._nonTerminalFlagToSymbolModifier(node.value.flag);
        let t = new Tree<PhpSymbol>(s);
        this._assignClassBody(t, body);
        this._assignClassPhpDoc(t, node.value.doc);
        this._assignLocation(s, node.value);
        this.symbolTreeRoot.addChild(t);

    }

    private _addClassMagicMembers(classNode: Tree<PhpSymbol>, doc: PhpDoc) {

        let tag: Tag;
        for (let n = 0; n < doc.tags.length; ++n) {
            tag = doc.tags[n];
            if (tag.tagName.indexOf('@property') !== -1) {
                classNode.addChild(this._propertyTagToTreeSymbol(<TypeTag>tag));
            } else if (tag.tagName === '@method') {
                classNode.addChild(this._methodTagToTreeSymbol(<MethodTag>tag));
            }
        }

    }

    private _nonTerminalFlagToSymbolModifier(flag: NonTerminalFlag) {

        let symbolModifier = 0;
        if ((flag & NonTerminalFlag.ModifierFinal) === NonTerminalFlag.ModifierFinal) {
            symbolModifier = SymbolModifier.Final;
        }

        if ((flag & NonTerminalFlag.ModifierAbstract) === NonTerminalFlag.ModifierAbstract) {
            symbolModifier |= SymbolModifier.Abstract;
        }

        if ((flag & NonTerminalFlag.ModifierPrivate) === NonTerminalFlag.ModifierPrivate) {
            symbolModifier |= SymbolModifier.Private;
        }

        if ((flag & NonTerminalFlag.ModifierProtected) === NonTerminalFlag.ModifierProtected) {
            symbolModifier |= SymbolModifier.Protected;
        }

        if ((flag & NonTerminalFlag.ModifierPublic) === NonTerminalFlag.ModifierPublic) {
            symbolModifier |= SymbolModifier.Public;
        }

        if ((flag & NonTerminalFlag.ModifierStatic) === NonTerminalFlag.ModifierStatic) {
            symbolModifier |= SymbolModifier.Static;
        }

        return symbolModifier;
    }

    private _propertyTagToTreeSymbol(tag: TypeTag): Tree<PhpSymbol> {

        let modifiers = SymbolModifier.Public | SymbolModifier.Magic;
        if (tag.tagName === '@property-write') {
            modifiers |= SymbolModifier.WriteOnly;
        } else if (tag.tagName === '@property-read') {
            modifiers |= SymbolModifier.ReadOnly;
        }

        let s = new PhpSymbol(SymbolKind.Property, tag.name);
        s.description = tag.description;
        s.modifiers = modifiers;
        s.type = new TypeString(tag.typeString);
        return new Tree<PhpSymbol>(s);
    }

    private _methodTagToTreeSymbol(tag: MethodTag): Tree<PhpSymbol> {
        let s = new PhpSymbol(SymbolKind.Method, tag.name);
        s.modifiers = SymbolModifier.Public | SymbolModifier.Magic;
        s.description = tag.description;
        s.type = new TypeString(tag.returnTypeString);
        let t = new Tree<PhpSymbol>(s);

        for (let n = 0; n < tag.parameters.length; ++n) {
            t.addChild(this._methodTagParamToSymbol(tag.parameters[n]));
        }

        return t;
    }

    private _methodTagParamToSymbol(methodTagParam: MethodTagParam): Tree<PhpSymbol> {

        let s = new PhpSymbol(SymbolKind.Parameter, methodTagParam.name);
        s.type = new TypeString(methodTagParam.typeString);
        return new Tree<PhpSymbol>(s);

    }

}

export class PathReader implements TreeVisitor<NonTerminal | Token>{

    private _path: Tree<NonTerminal>[];
    private _position: Position;

    constructor(position: Position) {
        this._position = position;
    }

    preOrder(node: Tree<NonTerminal | Token>) {

        if (node.value !== null && node.value.hasOwnProperty('nonTerminalType') &&
            util.isInRange(this._position,
                (<NonTerminal>node.value).startToken.range.start,
                (<NonTerminal>node.value).endToken.range.end)) {
            this._path.push(<Tree<NonTerminal>>node);
        }

    }

    shouldDescend(node: Tree<NonTerminal | Token>) {

        if (node.value === null || !node.value.hasOwnProperty('nonTerminalType')) {
            return false;
        }

        return util.isInRange(this._position,
            (<NonTerminal>node.value).startToken.range.start,
            (<NonTerminal>node.value).endToken.range.end
        );

    }

}

const enum TypeResolverMode {
    None, Assignment, InstanceOf, ResolveVariableName, ResolveType, Foreach
}

export class TypeResolver implements TreeVisitor<NonTerminal | Token>{

    private _stack: any[];
    private _modeStack: TypeResolverMode[];

    constructor(public variableTable: ResolvedVariableTable, public nameResolver: NameResolver) {
        this._stack = [];
        this._modeStack = [];
    }

    preOrder(node: Tree<NonTerminal | Token>) {

        if (node.value === null) {
            return;
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.FunctionDeclaration:
            case NonTerminalType.MethodDeclaration:
            case NonTerminalType.ClassDeclaration:
            case NonTerminalType.AnonymousClassDeclaration:
                this.variableTable.pushScope();
                break;
            case NonTerminalType.IfList:
                this.variableTable.pushBranchGroup();
                break;
            case NonTerminalType.If:
                this.variableTable.pushBranch();
                break;
            case NonTerminalType.BinaryExpression:
                if ((<NonTerminal>node.value).flag === NonTerminalFlag.BinaryAssign ||
                    (<NonTerminal>node.value).flag === NonTerminalFlag.BinaryInstanceOf) {
                    this._modeStack.push(TypeResolverMode.ResolveVariableName);
                }
                break;
            case NonTerminalType.Foreach:
                this._modeStack.push(TypeResolverMode.ResolveType);
                break;
            default:
                break;
        }

    }

    inOrder(node: Tree<NonTerminal | Token>, childIndex: number) {

        if (node.value === null) {
            return;
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.BinaryExpression:
                if (((<NonTerminal>node.value).flag === NonTerminalFlag.BinaryAssign ||
                    (<NonTerminal>node.value).flag === NonTerminalFlag.BinaryInstanceOf) &&
                    childIndex === 0) {
                    this._modeStack.pop();
                    this._modeStack.push(TypeResolverMode.ResolveType);
                }
                break;
            case NonTerminalType.Foreach:
            
                break;
            default:
                break;
        }

    }

    postOrder(node: Tree<NonTerminal | Token>) {

        if (this._modeStack.length < 1) {
            return;
        }

        if (node.value === null) {
            this._stack.push(null);
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.FunctionDeclaration:
            case NonTerminalType.MethodDeclaration:
            case NonTerminalType.ClassDeclaration:
            case NonTerminalType.AnonymousClassDeclaration:
                this.variableTable.popScope();
                break;
            case NonTerminalType.IfList:
                this.variableTable.popBranchGroup();
                break;
            case NonTerminalType.If:
                this.variableTable.popBranch();
                break;
            case NonTerminalType.Variable:
                this._postOrderVariable(node);
                break;
            case NonTerminalType.BinaryExpression:
                if ((<NonTerminal>node.value).flag === NonTerminalFlag.BinaryAssign) {
                    this._postOrderAssignment(node);
                } else {
                    util.popMany(this._stack, node.children.length);
                    this._stack.push(null);
                }
                break;
            case NonTerminalType.Foreach:
                this._modeStack.pop();
                break;
            case NonTerminalType.Name:

                break;
            case NonTerminalType.NamespaceName:
                if (util.top(this._modeStack) === TypeResolverMode.ResolveType) {
                    this._stack.push(util.popMany(this._stack, node.children.length).join('\\'));
                }
                break;
            case undefined:
                if (util.top(this._modeStack) === TypeResolverMode.ResolveType) {
                    this._stack.push((<Token>node.value).text);
                }
                break;
            default:
                break;
        }

    }

    shouldDescend(node: Tree<NonTerminal | Token>) {

        if (node.value === null) {
            return false;
        }

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.Variable:

                return false;
            default:
                return true;
        }
    }

    private _postOrderResolveType(node: Tree<NonTerminal | Token>) {

        switch ((<NonTerminal>node.value).nonTerminalType) {
            case NonTerminalType.FunctionDeclaration:
            case NonTerminalType.MethodDeclaration:
            case NonTerminalType.ClassDeclaration:
            case NonTerminalType.AnonymousClassDeclaration:
                this.variableTable.popScope();
                break;
            case NonTerminalType.IfList:
                this.variableTable.popBranchGroup();
                break;
            case NonTerminalType.If:
                this.variableTable.popBranch();
                break;
            case NonTerminalType.Variable:
                this._postOrderVariable(node);
                break;
            case NonTerminalType.BinaryExpression:
                if ((<NonTerminal>node.value).flag === NonTerminalFlag.BinaryAssign) {
                    this._postOrderAssignment(node);
                } else {
                    util.popMany(this._stack, node.children.length);
                    this._stack.push(null);
                }
                break;
            case NonTerminalType.Foreach:
                this._modeStack.pop();
                break;
            case NonTerminalType.Name:

                break;
            case NonTerminalType.NamespaceName:
                this._stack.push(util.popMany(this._stack, node.children.length).join('\\'));
                break;
            case undefined:
                this._stack.push((<Token>node.value).text);
                break;
            default:
                break;
        }


    }

    private postOrderNameResolveType(node: Tree<NonTerminal>) {
        let name = this._stack.pop();
        if (!name) {
            this._stack.push(null);
        }

        switch (node.value.flag) {
            case NonTerminalFlag.NameNotFullyQualified:
                name = this.nameResolver.resolveNotFullyQualified(name, );
                break;
            case NonTerminalFlag.NameRelative:
                name = this.nameResolver.resolveRelative(name);
                break;
            default:
                break;
        }
    }

    private _postOrderVariableResolveName(node: Tree<NonTerminal | Token>) {
        let child = node.children[0];
        let name = null;
        if (child.value.hasOwnProperty('tokenType')) {
            name = (<Token>child.value).text;
        }
        this._stack.push(name);
    }

    private _postOrderVariableResolveType(node: Tree<NonTerminal | Token>) {

        let child = node.children[0];
        let type = null;
        if (child.value.hasOwnProperty('tokenType')) {
            let type = this.variableTable.getType((<Token>child.value).text);
        }
        this._stack.push(type);
    }

    private _postOrderAssignment(node) {

        let varName: string, type: TypeString;
        [varName, type] = util.popMany(this._stack)

    }


}



/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { PhpSymbol, SymbolKind, SymbolModifier, Reference, SymbolIdentifier } from './symbol';
import { TreeTraverser, Predicate, TreeVisitor, Traversable, BinarySearch } from './types';
import { Position, Location, Range } from 'vscode-languageserver-types';
import { TypeString } from './typeString';
import * as builtInSymbols from './builtInSymbols.json';
import { ParsedDocument, ParsedDocumentChangeEventArgs } from './parsedDocument';
import { SymbolReader } from './symbolReader';
import { NameResolver } from './nameResolver';
import * as util from './util';
import { TypeAggregate, MemberMergeStrategy } from './typeAggregate';
import { ReferenceReader } from './referenceReader';

export class SymbolTable implements Traversable<PhpSymbol> {

    private _uri: string;
    private _root: PhpSymbol;
    private _hash: number;

    constructor(uri: string, root: PhpSymbol) {
        this._uri = uri;
        this._root = root;
        this._hash = util.hash32(uri);
    }

    get uri() {
        return this._uri;
    }

    get root() {
        return this._root;
    }

    get hash() {
        return this._hash;
    }

    get symbols() {
        let traverser = new TreeTraverser([this.root]);
        let symbols = traverser.toArray();
        //remove root
        symbols.shift();
        return symbols;
    }

    get symbolCount() {
        let traverser = new TreeTraverser([this.root]);
        //subtract 1 for root
        return traverser.count() - 1;
    }

    get referenceCount() {
        return this.references().length;
    }

    parent(s: PhpSymbol) {
        let traverser = new TreeTraverser([this.root]);
        let fn = (x: PhpSymbol) => {
            return x === s;
        };
        if (!traverser.find(fn)) {
            return null;
        }

        return traverser.parent();
    }

    traverse(visitor: TreeVisitor<PhpSymbol>) {
        let traverser = new TreeTraverser([this.root]);
        traverser.traverse(visitor);
        return visitor;
    }

    filter(predicate: Predicate<PhpSymbol>) {
        let traverser = new TreeTraverser([this.root]);
        return traverser.filter(predicate)
    }

    find(predicate: Predicate<PhpSymbol>) {
        let traverser = new TreeTraverser([this.root]);
        return traverser.find(predicate);
    }

    nameResolver(pos: Position) {
        let nameResolver = new NameResolver();
        let traverser = new TreeTraverser([this.root]);
        let visitor = new NameResolverVisitor(pos, nameResolver);
        traverser.traverse(visitor);
        return nameResolver;
    }

    scope(pos: Position) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ScopeVisitor(pos, false);
        traverser.traverse(visitor);
        return visitor.scope;
    }

    absoluteScope(pos: Position) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ScopeVisitor(pos, true);
        traverser.traverse(visitor);
        return visitor.scope;
    }

    scopeSymbols() {
        return this.filter(this._isScopeSymbol);
    }

    symbolAtPosition(position: Position) {

        let pred = (x: PhpSymbol) => {
            return x.location &&
                x.location.range.start.line === position.line &&
                x.location.range.start.character === position.character;
        };

        return this.filter(pred).pop();
    }

    references(filter?: Predicate<Reference>) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ReferencesVisitor(filter);
        traverser.traverse(visitor);
        return visitor.references;
    }

    referenceAtPosition(position:Position) {

        let s = this.scope(position);
        let fn = (ref:Reference) => {
            return util.isInRange(position, ref.location.range) === 0;
        }
        return s.references ? util.find<Reference>(s.references, fn) : undefined;

    }

    contains(identifier: SymbolIdentifier) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ContainsVisitor(identifier);
        traverser.traverse(visitor);
        return visitor.found;
    }

    private _isScopeSymbol(s: PhpSymbol) {
        const mask = SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait | SymbolKind.None | SymbolKind.Function | SymbolKind.Method;
        return (s.kind & mask) > 0;
    }

    private _hasReferences(s: PhpSymbol) {
        return s.references !== undefined;
    }

    static create(parsedDocument: ParsedDocument, externalOnly?: boolean) {

        let symbolReader = new SymbolReader(parsedDocument, new NameResolver());

        parsedDocument.traverse(symbolReader);
        return new SymbolTable(
            parsedDocument.uri,
            symbolReader.symbol
        );

    }

    static readBuiltInSymbols() {

        return new SymbolTable('php', {
            kind: SymbolKind.None,
            name: '',
            children: <any>builtInSymbols
        });

    }

}

export class SymbolStore {

    private _tableIndex: SymbolTableIndex;
    private _symbolIndex: NameIndex<PhpSymbol>;
    private _referenceIndex: NameIndex<Reference>;
    private _symbolCount: number;

    constructor() {
        this._tableIndex = new SymbolTableIndex();
        this._symbolIndex = new NameIndex<PhpSymbol>(this._symbolKeys);
        this._referenceIndex = new NameIndex<Reference>(this._referenceKeys);
        this._symbolCount = 0;
    }

    onParsedDocumentChange = (args: ParsedDocumentChangeEventArgs) => {
        this.remove(args.parsedDocument.uri);
        let table = SymbolTable.create(args.parsedDocument);
        this.add(table);
        ReferenceReader.discoverReferences(args.parsedDocument, table, this);
        this.indexReferences(table);
    };

    getSymbolTable(uri: string) {
        return this._tableIndex.find(uri);
    }

    get tableCount() {
        return this._tableIndex.count();
    }

    get symbolCount() {
        return this._symbolCount;
    }

    add(symbolTable: SymbolTable) {
        this._tableIndex.add(symbolTable);
        this._symbolIndex.addMany(this._indexSymbols(symbolTable.root));
        this._referenceIndex.addMany(symbolTable.references(this._indexableReferenceFilter));
        this._symbolCount += symbolTable.symbolCount;
    }

    remove(uri: string) {
        let symbolTable = this._tableIndex.remove(uri);
        if (!symbolTable) {
            return;
        }
        this._symbolIndex.removeMany(this._indexSymbols(symbolTable.root));
        this._referenceIndex.removeMany(symbolTable.references(this._indexableReferenceFilter));
        this._symbolCount -= symbolTable.symbolCount;
    }

    indexReferences(symbolTable: SymbolTable) {

        let references = symbolTable.references(this._indexableReferenceFilter);
        this._referenceIndex.removeMany(references);
        this._referenceIndex.addMany(references);
    }

    /**
     * Finds all indexed symbols that match text exactly.
     * Case sensitive for constants and variables and insensitive for 
     * classes, traits, interfaces, functions, methods
     * @param text 
     * @param filter 
     */
    find(text: string, filter?: Predicate<PhpSymbol>) {

        if (!text) {
            return [];
        }

        let lcText = text.toLowerCase();
        let kindMask = SymbolKind.Constant | SymbolKind.Variable;
        let result = this._symbolIndex.find(text);
        let symbols: PhpSymbol[] = [];
        let s: PhpSymbol;

        for (let n = 0, l = result.length; n < l; ++n) {
            s = result[n];
            if ((!filter || filter(s)) &&
                (((s.kind & kindMask) > 0 && s.name === text) ||
                    (!(s.kind & kindMask) && s.name.toLowerCase() === lcText))) {
                symbols.push(s);
            }
        }

        return symbols;
    }

    /**
     * matches indexed symbols where symbol keys begin with text.
     * Case insensitive
     */
    match(text: string, filter?: Predicate<PhpSymbol>) {

        if (!text) {
            return [];
        }

        let matches: PhpSymbol[] = this._symbolIndex.match(text);

        if (!filter) {
            return matches;
        }

        let filtered: PhpSymbol[] = [];
        let s: PhpSymbol;

        for (let n = 0, l = matches.length; n < l; ++n) {
            s = matches[n];
            if (filter(s)) {
                filtered.push(s);
            }
        }

        return filtered;
    }

    findSymbolsByReference(ref: Reference, memberMergeStrategy?: MemberMergeStrategy): PhpSymbol[] {
        if (!ref) {
            return [];
        }

        let symbols: PhpSymbol[];
        let fn: Predicate<PhpSymbol>;
        let lcName: string;
        let table: SymbolTable;

        switch (ref.kind) {
            case SymbolKind.Class:
            case SymbolKind.Interface:
            case SymbolKind.Trait:
                fn = (x) => {
                    return (x.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait)) > 0;
                };
                symbols = this.find(ref.name, fn);
                break;

            case SymbolKind.Function:
            case SymbolKind.Constant:
                fn = (x) => {
                    return x.kind === ref.kind;
                };
                symbols = this.find(ref.name, fn);
                if (symbols.length < 1 && ref.altName) {
                    symbols = this.find(ref.altName, fn);
                }
                break;

            case SymbolKind.Method:
                lcName = ref.name.toLowerCase();
                fn = (x) => {
                    return x.kind === SymbolKind.Method && x.name.toLowerCase() === lcName;
                };
                symbols = this.findMembers(ref.scope, memberMergeStrategy || MemberMergeStrategy.None, fn);
                break;

            case SymbolKind.Property:
                {
                    let name = ref.name;
                    fn = (x) => {
                        return x.kind === SymbolKind.Property && name === x.name;
                    };
                    symbols = this.findMembers(ref.scope, memberMergeStrategy || MemberMergeStrategy.None, fn);
                    break;
                }

            case SymbolKind.ClassConstant:
                fn = (x) => {
                    return x.kind === SymbolKind.ClassConstant && x.name === ref.name;
                };
                symbols = this.findMembers(ref.scope, memberMergeStrategy || MemberMergeStrategy.None, fn);
                break;

            case SymbolKind.Variable:
            case SymbolKind.Parameter:
                table = this._tableIndex.findByIdentifier(ref);
                if (table) {
                    let scope = table.scope(ref.location.range.start);

                    fn = (x) => {
                        return (x.kind & (SymbolKind.Parameter | SymbolKind.Variable)) > 0 &&
                            x.name === ref.name;
                    }
                    let s = scope.children ? scope.children.find(fn) : null;
                    if (s) {
                        symbols = [s];
                    }
                }
                break;

            case SymbolKind.Constructor:
                fn = (x) => {
                    return x.kind === SymbolKind.Method && x.name.toLowerCase() === '__construct';
                };
                symbols = this.findMembers(ref.name, memberMergeStrategy || MemberMergeStrategy.None, fn);
                break;

            default:
                break;

        }

        return symbols || [];
    }

    findMembers(scope: string, memberMergeStrategy: MemberMergeStrategy, predicate?: Predicate<PhpSymbol>) {

        let fqnArray = TypeString.atomicClassArray(scope);
        let type: TypeAggregate;
        let members:PhpSymbol[] = [];
        for (let n = 0; n < fqnArray.length; ++n) {
            type = TypeAggregate.create(this, fqnArray[n]);
            if (type) {
                Array.prototype.push.apply(members, type.members(memberMergeStrategy, predicate));
            }
        }
        return Array.from(new Set<PhpSymbol>(members));
    }

    findBaseMember(symbol: PhpSymbol) {

        if (
            !symbol || !symbol.scope ||
            !(symbol.kind & (SymbolKind.Property | SymbolKind.Method | SymbolKind.ClassConstant)) ||
            (symbol.modifiers & SymbolModifier.Private) > 0
        ) {
            return symbol;
        }

        let fn: Predicate<PhpSymbol>;

        if (symbol.kind === SymbolKind.Method) {
            let name = symbol.name.toLowerCase();
            fn = (s: PhpSymbol) => {
                return s.kind === symbol.kind && s.modifiers === symbol.modifiers && name === s.name.toLowerCase();
            };
        } else {
            fn = (s: PhpSymbol) => {
                return s.kind === symbol.kind && s.modifiers === symbol.modifiers && symbol.name === s.name;
            };
        }

        return this.findMembers(symbol.scope, MemberMergeStrategy.Base, fn).shift() || symbol;

    }

    findOverrides(baseSymbol: PhpSymbol): PhpSymbol[] {

        if (
            !baseSymbol ||
            !(baseSymbol.kind & (SymbolKind.Property | SymbolKind.Method | SymbolKind.ClassConstant)) ||
            (baseSymbol.modifiers & SymbolModifier.Private) > 0
        ) {
            return [];
        }

        let baseTypeName = baseSymbol.scope ? baseSymbol.scope : '';
        let baseType = this.find(baseTypeName, PhpSymbol.isClassLike).shift();
        if (!baseType || baseType.kind === SymbolKind.Trait) {
            return [];
        }
        let store = this;
        let filterFn = (s: PhpSymbol) => {

            if (s.kind !== baseSymbol.kind || s.modifiers !== baseSymbol.modifiers || s === baseSymbol) {
                return false;
            }

            let type = store.find(s.scope).shift();
            if (!type) {
                return false;
            }

            if (PhpSymbol.isAssociated(type, baseTypeName)) {
                return true;
            }

            let aggregate = new TypeAggregate(store, type);
            return aggregate.isAssociated(baseTypeName);

        };
        return this.find(baseSymbol.name, filterFn);

    }

    findReferences(name: string, filter?: Predicate<Reference>): Reference[] {

        if (!name) {
            return [];
        }

        let matches = this._referenceIndex.find(name);
        let filtered: Reference[] = [];
        let match: Reference;
        const caseSensitiveKindMask = SymbolKind.Property | SymbolKind.Variable | SymbolKind.Constant | SymbolKind.ClassConstant;

        for (let n = 0; n < matches.length; ++n) {
            match = matches[n];
            if (!filter || filter(match)) {
                if (!(match.kind & caseSensitiveKindMask) || name === match.name) {
                    filtered.push(match);
                }
            }
        }

        return filtered;

    }

    identifierLocation(identifier: SymbolIdentifier): Location {
        let table = this._tableIndex.findByIdentifier(identifier);
        return table ? Location.create(table.uri, identifier.location.range) : null;
    }

    referenceToTypeString(ref: Reference) {

        if (!ref) {
            return '';
        }

        switch (ref.kind) {
            case SymbolKind.Class:
            case SymbolKind.Interface:
            case SymbolKind.Trait:
            case SymbolKind.Constructor:
                return ref.name;

            case SymbolKind.Function:
            case SymbolKind.Method:
            case SymbolKind.Property:
                return this.findSymbolsByReference(ref, MemberMergeStrategy.Documented).reduce<string>((carry, val) => {
                    return TypeString.merge(carry, PhpSymbol.type(val));
                }, '');

            case SymbolKind.Variable:
                return ref.type || '';

            default:
                return '';


        }
    }

    private _sortMatches(query: string, matches: PhpSymbol[]) {

        let map: { [index: string]: number } = {};
        let s: PhpSymbol;
        let name: string;
        let val: number;
        query = query.toLowerCase();

        for (let n = 0, l = matches.length; n < l; ++n) {
            s = matches[n];
            name = s.name;
            if (map[name] === undefined) {
                val = (PhpSymbol.notFqn(s.name).toLowerCase().indexOf(query) + 1) * 10;
                if (val > 0) {
                    val = 1000 - val;
                }
                map[name] = val;
            }
            ++map[name];
        }

        let unique = Array.from(new Set(matches));

        let sortFn = (a: PhpSymbol, b: PhpSymbol) => {
            return map[b.name] - map[a.name];
        }

        unique.sort(sortFn);
        return unique;

    }

    private _classOrInterfaceFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface)) > 0;
    }

    private _classInterfaceTraitFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait)) > 0;
    }

    private _indexSymbols(root: PhpSymbol) {

        let traverser = new TreeTraverser([root]);
        return traverser.filter(this._indexFilter);

    }

    private _indexableReferenceFilter(ref: Reference) {
        return ref.kind !== SymbolKind.Parameter && ref.kind !== SymbolKind.Variable;
    }

    /**
     * No vars, params or symbols with use modifier or private modifier
     * @param s 
     */
    private _indexFilter(s: PhpSymbol) {
        return !(s.kind & (SymbolKind.Parameter | SymbolKind.Variable | SymbolKind.File)) &&
            !(s.modifiers & (SymbolModifier.Use | SymbolModifier.Private)) &&
            s.name.length > 0;
    }

    private _symbolKeys(s: PhpSymbol) {

        if (s.kind === SymbolKind.Namespace) {
            let lcName = s.name.toLowerCase();
            let keys = new Set<string>();
            keys.add(lcName);
            Set.prototype.add.apply(keys, lcName.split('\\').filter((s) => { return s.length > 0 }));
            return Array.from(keys);
        }

        return PhpSymbol.keys(s);
    }

    private _referenceKeys(ref: Reference) {

        let lcName = ref.name.toLowerCase();
        let keys = [lcName];
        if (ref.altName) {
            let lcAlt = ref.altName.toLowerCase();
            if (lcAlt !== lcName && lcAlt !== 'static' && lcAlt !== 'self' && lcAlt !== 'parent') {
                keys.push(lcAlt);
            }
        }

        return keys;

    }

}

class NameResolverVisitor implements TreeVisitor<PhpSymbol> {

    haltTraverse = false;
    private _kindMask = SymbolKind.Class | SymbolKind.Function | SymbolKind.Constant;

    constructor(public pos: Position, public nameResolver: NameResolver) { }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (node.location && node.location.range.start.line > this.pos.line) {
            this.haltTraverse = true;
            return false;
        }

        if ((node.modifiers & SymbolModifier.Use) > 0 && (node.kind & this._kindMask) > 0) {
            this.nameResolver.rules.push(node);
        } else if (node.kind === SymbolKind.Namespace) {
            this.nameResolver.namespace = node;
        } else if (node.kind === SymbolKind.Class) {
            this.nameResolver.pushClass(node);
        }

        return true;

    }

    postorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (this.haltTraverse) {
            return;
        }

        if (node.kind === SymbolKind.Class) {
            this.nameResolver.popClass();
        }

    }
}

class ScopeVisitor implements TreeVisitor<PhpSymbol> {

    haltTraverse = false;
    private _scopeStack: PhpSymbol[];
    private _kindMask = SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait | SymbolKind.Function | SymbolKind.Method | SymbolKind.File;
    private _absolute = false;

    constructor(public pos: Position, absolute: boolean) {
        this._scopeStack = [];
        this._absolute = absolute;
    }

    get scope() {
        return this._scopeStack[this._scopeStack.length - 1];
    }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (node.location && node.location.range.start.line > this.pos.line) {
            this.haltTraverse = true;
            return false;
        }

        if (!node.location || util.isInRange(this.pos, node.location.range) !== 0) {
            return false;
        }

        if (
            (node.kind & this._kindMask) > 0 &&
            !(node.modifiers & SymbolModifier.Use) &&
            (!this._absolute || node.kind !== SymbolKind.Function || !(node.modifiers & SymbolModifier.Anonymous))
        ) {
            this._scopeStack.push(node);
        }

        return true;
    }

}

class ReferencesVisitor implements TreeVisitor<PhpSymbol> {

    private _filter: Predicate<Reference>;
    private _refs: Reference[];

    constructor(filter?: Predicate<Reference>) {
        this._filter = filter;
        this._refs = [];
    }

    get references() {
        return this._refs;
    }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (!node.references) {
            return true;
        }

        if (this._filter) {
            let r: Reference;
            for (let n = 0; n < node.references.length; ++n) {
                r = node.references[n];
                if (this._filter(r)) {
                    this._refs.push(r);
                }
            }

        } else {
            Array.prototype.push.apply(this._refs, node.references);
        }

        return true;

    }

}

class ContainsVisitor implements TreeVisitor<PhpSymbol> {

    haltTraverse = false;
    found = false;
    private _identifier: SymbolIdentifier;

    constructor(identifier: SymbolIdentifier) {
        this._identifier = identifier;
        if (!identifier.location) {
            throw new Error('Invalid Argument');
        }
    }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (node === this._identifier) {
            this.found = true;
            this.haltTraverse = true;
            return false;
        }

        if (node.location && util.isInRange(this._identifier.location.range.start, node.location.range) !== 0) {
            return false;
        }

        if (node.references && node.references.indexOf(this._identifier) > -1) {
            this.found = true;
            this.haltTraverse = true;
            return false;
        }

        return true;

    }

}

interface NameIndexNode<T> {
    key: string;
    items: T[];
}

export type KeysDelegate<T> = (t: T) => string[];

export class NameIndex<T> {

    private _keysDelegate: KeysDelegate<T>;
    private _nodeArray: NameIndexNode<T>[];
    private _binarySearch: BinarySearch<NameIndexNode<T>>;
    private _collator: Intl.Collator;

    constructor(keysDelegate: KeysDelegate<T>) {
        this._keysDelegate = keysDelegate;
        this._nodeArray = [];
        this._binarySearch = new BinarySearch<NameIndexNode<T>>(this._nodeArray);
        this._collator = new Intl.Collator('en');
    }

    add(item: T) {

        let suffixes = this._keysDelegate(item);
        let node: NameIndexNode<T>;

        for (let n = 0; n < suffixes.length; ++n) {

            node = this._nodeFind(suffixes[n]);

            if (node) {
                node.items.push(item);
            } else {
                this._insertNode({ key: suffixes[n], items: [item] });
            }
        }

    }

    addMany(items: T[]) {
        for (let n = 0; n < items.length; ++n) {
            this.add(items[n]);
        }
    }

    remove(item: T) {

        let suffixes = this._keysDelegate(item);
        let node: NameIndexNode<T>;
        let i: number;

        for (let n = 0; n < suffixes.length; ++n) {

            node = this._nodeFind(suffixes[n]);
            if (!node) {
                continue;
            }

            i = node.items.indexOf(item);

            if (i !== -1) {
                node.items.splice(i, 1);
                if (!node.items.length) {
                    //uneccessary? save a lookup and splice
                    //this._deleteNode(node);
                }
            }

        }

    }

    removeMany(items: T[]) {
        for (let n = 0; n < items.length; ++n) {
            this.remove(items[n]);
        }
    }

    /**
     * Matches all items that are prefixed with text
     * @param text 
     */
    match(text: string) {

        text = text.toLowerCase();
        let nodes = this._nodeMatch(text);
        let matches:PhpSymbol[] = [];

        for (let n = 0; n < nodes.length; ++n) {
            Array.prototype.push.apply(matches, nodes[n].items);
        }

        return Array.from(new Set<PhpSymbol>(matches));

    }

    /**
     * Finds all items that match (case insensitive) text exactly
     * @param text 
     */
    find(text: string) {
        let node = this._nodeFind(text.toLowerCase());
        return node ? node.items : [];
    }

    private _nodeMatch(lcText: string) {

        let collator = this._collator;
        let compareLowerFn = (n: NameIndexNode<T>) => {
            return collator.compare(n.key, lcText);
        };
        let compareUpperFn = (n: NameIndexNode<T>) => {
            return n.key.slice(0, lcText.length) === lcText ? -1 : 1;
        }

        return this._binarySearch.range(compareLowerFn, compareUpperFn);

    }

    private _nodeFind(lcText: string) {

        let collator = this._collator;
        let compareFn = (n: NameIndexNode<T>) => {
            return collator.compare(n.key, lcText);
        }

        return this._binarySearch.find(compareFn);

    }

    private _insertNode(node: NameIndexNode<T>) {

        let collator = this._collator;
        let rank = this._binarySearch.rank((n) => {
            return collator.compare(n.key, node.key);
        });

        this._nodeArray.splice(rank, 0, node);

    }

    private _deleteNode(node: NameIndexNode<T>) {

        let collator = this._collator;
        let rank = this._binarySearch.rank((n) => {
            return collator.compare(n.key, node.key);
        });

        if (this._nodeArray[rank] === node) {
            this._nodeArray.splice(rank, 1);
        }

    }

}

class SymbolTableIndex {

    private _tables: SymbolTableIndexNode[];
    private _search: BinarySearch<SymbolTableIndexNode>;
    private _count = 0;

    constructor() {
        this._tables = [];
        this._search = new BinarySearch<SymbolTableIndexNode>(this._tables);
    }

    count() {
        return this._count;
    }

    add(table: SymbolTable) {
        let fn = this._createCompareFn(table.uri);
        let search = this._search.search(fn);
        if (search.isExactMatch) {
            let node = this._tables[search.rank];
            if (node.tables.find(this._createUriFindFn(table.uri))) {
                --this._count;
                throw new Error(`Duplicate key ${table.uri}`);
            }
            node.tables.push(table);
        } else {
            let node = <SymbolTableIndexNode>{ hash: table.hash, tables: [table] };
            this._tables.splice(search.rank, 0, node);
        }
        ++this._count;
    }

    remove(uri: string) {
        let fn = this._createCompareFn(uri);
        let node = this._search.find(fn);
        if (node) {
            let i = node.tables.findIndex(this._createUriFindFn(uri));
            if (i > -1) {
                --this._count;
                return node.tables.splice(i, 1).pop();
            }
        }
    }

    find(uri: string) {
        let fn = this._createCompareFn(uri);
        let node = this._search.find(fn);
        return node ? node.tables.find(this._createUriFindFn(uri)) : null;
    }

    findByIdentifier(i: SymbolIdentifier) {
        if (!i.location) {
            return null;
        }

        let node = this._search.find((x) => {
            return x.hash - i.location.uriHash;
        });

        if (!node || !node.tables.length) {
            return null;
        } else if (node.tables.length === 1) {
            return node.tables[0];
        } else {
            let table: SymbolTable;
            for (let n = 0; n < node.tables.length; ++n) {
                table = node.tables[n];
                if (table.contains(i)) {
                    return table;
                }
            }
        }

        return null;
    }

    private _createCompareFn(uri: string) {
        let hash = util.hash32(uri);
        return (x: SymbolTableIndexNode) => {
            return x.hash - hash;
        };
    }

    private _createUriFindFn(uri: string) {
        return (x: SymbolTable) => {
            return x.uri === uri;
        };
    }

}

interface SymbolTableIndexNode {
    hash: number;
    tables: SymbolTable[];
}

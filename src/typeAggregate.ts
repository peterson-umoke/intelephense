/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { PhpSymbol, SymbolKind, SymbolModifier } from './symbol';
import { SymbolStore } from './symbolStore';
import { Predicate } from './types';
import * as util from './util';

export const enum MemberMergeStrategy {
    None, //returns all symbols
    Override, //first matching member encountered is chosen ie prefer overrides
    Documented, //prefer first unless it has no doc and base does
    Base //last matching member encountered ie prefer base
}

export class TypeAggregate {

    private _symbol: PhpSymbol;
    private _associated: PhpSymbol[];

    constructor(public symbolStore: SymbolStore, symbol: PhpSymbol) {
        if (!symbol || !(symbol.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait))) {
            throw new Error('Invalid Argument');
        }
        this._symbol = symbol;
    }

    get type() {
        return this._symbol;
    }

    isAssociated(name: string) {
        if (!name) {
            return false;
        }
        let lcName = name.toLowerCase();
        let fn = (x: PhpSymbol) => {
            return x.name.toLowerCase() === lcName;
        }
        return this.associated(fn).length > 0;
    }

    associated(filter?: Predicate<PhpSymbol>) {
        let assoc = this._getAssociated();
        return filter ? util.filter(assoc, filter) : assoc;
    }

    members(mergeStrategy: MemberMergeStrategy, predicate?: Predicate<PhpSymbol>) {

        let associated = this._getAssociated().slice(0);
        associated.unshift(this._symbol);

        switch (this._symbol.kind) {
            case SymbolKind.Class:
                return this._classMembers(associated, mergeStrategy, predicate);
            case SymbolKind.Interface:
                return this._interfaceMembers(associated, predicate);
            case SymbolKind.Trait:
                return this._traitMembers(associated, predicate);
            default:
                return [];
        }

    }

    /**
     * root type should be first element of associated array
     * @param associated 
     * @param predicate 
     */
    private _classMembers(associated: PhpSymbol[], strategy:MemberMergeStrategy, predicate?: Predicate<PhpSymbol>) {

        let members: PhpSymbol[] = [];
        let s: PhpSymbol;
        let traits: PhpSymbol[] = [];
        let noPrivate = (x: PhpSymbol) => {
            return !(x.modifiers & SymbolModifier.Private) && (!predicate || predicate(x));
        };

        for (let n = 0; n < associated.length; ++n) {
            s = associated[n];
            if (s.kind === SymbolKind.Trait) {
                traits.push(s);
            } else if (s.children) {
                Array.prototype.push.apply(members, predicate ? s.children.filter(predicate) : s.children);
            }

            predicate = noPrivate;
        }

        predicate = noPrivate;
        members = this._mergeMembers(members, strategy);
        //@todo trait precendence/alias
        Array.prototype.push.apply(members, this._traitMembers(traits, predicate));
        return members;

    }

    private _interfaceMembers(interfaces: PhpSymbol[], predicate?: Predicate<PhpSymbol>) {
        let members: PhpSymbol[] = [];
        let s: PhpSymbol;
        for (let n = 0; n < interfaces.length; ++n) {
            s = interfaces[n];
            if (s.children) {
                Array.prototype.push.apply(members, predicate ? s.children.filter(predicate) : s.children);
            }
        }
        return members;
    }

    private _traitMembers(traits: PhpSymbol[], predicate?: Predicate<PhpSymbol>) {
        //@todo support trait precendence and alias here
        return this._interfaceMembers(traits, predicate);
    }

    private _mergeMembers(symbols: PhpSymbol[], strategy: MemberMergeStrategy) {

        let map: { [index: string]: number } = {};
        let merged: PhpSymbol[] = [];
        let s: PhpSymbol;
        let index: number;

        if (strategy === MemberMergeStrategy.None) {
            return symbols;
        }

        for (let n = 0; n < symbols.length; ++n) {
            s = symbols[n];
            index = map[s.name];
            if (index === undefined) {
                merged.push(s);
                map[s.name] = merged.length - 1;
            } else if (
                ((merged[index].modifiers & SymbolModifier.Magic) > 0 && !(s.modifiers & SymbolModifier.Magic)) || //always prefer non magic
                (strategy === MemberMergeStrategy.Documented && !merged[index].doc && s.doc) ||
                (strategy === MemberMergeStrategy.Base)
            ) {
                merged[index] = s;
            }
        }

        return merged;
    }

    private _getAssociated() {

        if (this._associated) {
            return this._associated;
        }

        this._associated = [];
        let symbol = this._symbol;
        if (!symbol.associated || !symbol.associated.length) {
            return this._associated;
        }

        let queue: PhpSymbol[] = [];
        let stub: PhpSymbol;
        Array.prototype.push.apply(queue, symbol.associated);

        while ((stub = queue.shift())) {

            symbol = this.symbolStore.find(stub.name, PhpSymbol.isClassLike).shift();
            if (!symbol || this._associated.indexOf(symbol) > -1) {
                continue;
            }
            this._associated.push(symbol);
            if (symbol.associated) {
                Array.prototype.push.apply(queue, symbol.associated);
            }
        }

        return this._associated;

    }

    static create(symbolStore: SymbolStore, fqn: string) {

        if (!fqn) {
            return null;
        }

        let symbol = symbolStore.find(fqn, PhpSymbol.isClassLike).shift();
        if (!symbol) {
            return null;
        }

        return new TypeAggregate(symbolStore, symbol);

    }

}
import * as Rx from 'rxjs/Rx';
import * as fs from 'fs';
import * as XRegExp from 'xregexp';
import { genSequence, Sequence } from 'gensequence';
import * as Text from './text';
import { lineReaderRx } from './fileReader';
import { writeToFile, writeToFileRxP} from 'cspell-lib';
import { Observable } from 'rxjs/Rx';
import * as path from 'path';
import { mkdirp } from 'fs-extra';
import { observableFromIterable } from 'rxjs-from-iterable';
import * as Trie from 'cspell-trie';
import * as HR from 'hunspell-reader';

const regNonWordOrSpace = XRegExp("[^\\p{L}' ]+", 'gi');
const regExpSpaceOrDash = /(?:\s+)|(?:-+)/g;
const regExpRepeatChars = /(.)\1{3,}/i;

export function normalizeWords(lines: Rx.Observable<string>) {
    return lines.flatMap(line => lineToWords(line).toArray());
}

export function lineToWords(line: string): Sequence<string> {
    // Remove punctuation and non-letters.
    const filteredLine = line.replace(regNonWordOrSpace, '|');
    const wordGroups = filteredLine.split('|');

    const words = genSequence(wordGroups)
        .concatMap(a => [a, ...a.split(regExpSpaceOrDash)])
        .concatMap(a => splitCamelCase(a))
        .map(a => a.trim())
        .filter(s => s.length > 2)
        .filter(s => !regExpRepeatChars.test(s))
        .map(a => a.toLowerCase())
        .reduceToSequence<string, Set<string>>((s, w) => s.add(w), new Set<string>());

    return words;
}

function splitCamelCase(word: string): Sequence<string> | string[] {
    const splitWords = Text.splitCamelCaseWord(word);
    // We only want to preserve this: "New York" and not "Namespace DNSLookup"
    if (splitWords.length > 1 && regExpSpaceOrDash.test(word)) {
        return genSequence(splitWords).concatMap(w => w.split(regExpSpaceOrDash));
    }
    return splitWords;
}

export function compileSetOfWords(lines: Rx.Observable<string>): Promise<Set<string>> {
    const set = normalizeWords(lines)
            .reduce((s, w) => s.add(w), new Set<string>())
            .toPromise();

    return Promise.all([set]).then(a => a[0]);
}

export function compileWordList(filename: string, destFilename: string): Promise<fs.WriteStream> {
    const getWords = () => regHunspellFile.test(filename) ? readHunspellFiles(filename) : lineReaderRx(filename);

    const destDir = path.dirname(destFilename);

    return mkdirp(destDir).then(() => compileSetOfWords(getWords()))
    .then(set => {
        const data = genSequence(set)
            .map(a => a + '\n')
            .toArray()
            .sort()
            .join('');
        return writeToFile(destFilename, data);
    });
}


export function normalizeWordsToTrie(words: Rx.Observable<string>): Promise<Trie.TrieNode> {
    const result = normalizeWords(words)
        .reduce((node, word) => Trie.insert(word, node), {} as Trie.TrieNode)
        .toPromise();
    return result;
}

export function compileWordListToTrieFile(words: Rx.Observable<string>, destFilename: string): Promise<void> {
    const destDir = path.dirname(destFilename);
    const dir = mkdirp(destDir);
    const root = normalizeWordsToTrie(words);

    const data = Rx.Observable.zip(dir, root, (_: void, b: Trie.TrieNode) => b)
        .map(node => Trie.serializeTrie(node, { base: 32, comment: 'Built by cspell-tools.' }))
        .flatMap(seq => observableFromIterable(seq));

    return writeToFileRxP(destFilename, data.bufferCount(1024).map(a => a.join('')));
}

const regHunspellFile = /\.(dic|aff)$/i;

function readHunspellFiles(filename: string): Rx.Observable<string> {
    const dicFile = filename.replace(regHunspellFile, '.dic');
    const affFile = filename.replace(regHunspellFile, '.aff');

    const reader = HR.HunspellReader.createFromFiles(affFile, dicFile);

    const r = Rx.Observable.fromPromise(reader)
        .flatMap(reader => reader.readWordsRx())
        .map(aff => aff.word);
    return r;
}

export function compileTrie(filename: string, destFilename: string): Promise<void> {
    const words = regHunspellFile.test(filename) ? readHunspellFiles(filename) : lineReaderRx(filename);
    return compileWordListToTrieFile(words, destFilename);
}
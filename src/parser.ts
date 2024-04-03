import type {
    Alternative,
    Backreference,
    CapturingGroup,
    CharacterClass,
    CharacterClassRange,
    Flags,
    Group,
    RegExpLiteral,
    LookaroundAssertion,
    Pattern,
    Quantifier,
    ClassStringDisjunction,
    ClassIntersection,
    ClassSubtraction,
    UnicodeSetsCharacterClassElement,
    ClassSetOperand,
    UnicodeSetsCharacterClass,
    ExpressionCharacterClass,
    StringAlternative,
} from "./ast"
import type { EcmaVersion } from "./ecma-versions"
import { latestEcmaVersion } from "./ecma-versions"
import { HYPHEN_MINUS } from "./unicode"
import { RegExpValidator } from "./validator"

type AppendableNode =
    | Alternative
    | CapturingGroup
    | CharacterClass
    | ClassStringDisjunction
    | Group
    | LookaroundAssertion
    | Pattern
    | StringAlternative

const DUMMY_PATTERN: Pattern = {} as Pattern
const DUMMY_FLAGS: Flags = {} as Flags
const DUMMY_CAPTURING_GROUP: CapturingGroup = {} as CapturingGroup

function isClassSetOperand(
    node: UnicodeSetsCharacterClassElement,
): node is ClassSetOperand {
    return (
        node.type === "Character" ||
        node.type === "CharacterSet" ||
        node.type === "CharacterClass" ||
        node.type === "ExpressionCharacterClass" ||
        node.type === "ClassStringDisjunction"
    )
}

class RegExpParserState {
    public readonly strict: boolean

    public readonly ecmaVersion: EcmaVersion

    private _node: AppendableNode = DUMMY_PATTERN

    private _expressionBufferMap = new Map<
        CharacterClass | ExpressionCharacterClass,
        ClassIntersection | ClassSubtraction
    >()

    private _flags: Flags = DUMMY_FLAGS

    private _backreferences: Backreference[] = []

    private _capturingGroups: CapturingGroup[] = []

    public source = ""

    public constructor(options?: RegExpParser.Options) {
        this.strict = Boolean(options?.strict)
        this.ecmaVersion = options?.ecmaVersion ?? latestEcmaVersion
    }

    public get pattern(): Pattern {
        if (this._node.type !== "Pattern") {
            throw new Error("UnknownError")
        }
        return this._node
    }

    public get flags(): Flags {
        if (this._flags.type !== "Flags") {
            throw new Error("UnknownError")
        }
        return this._flags
    }

    public onRegExpFlags(
        start: number,
        end: number,
        {
            global,
            ignoreCase,
            multiline,
            unicode,
            sticky,
            dotAll,
            hasIndices,
            unicodeSets,
        }: {
            global: boolean
            ignoreCase: boolean
            multiline: boolean
            unicode: boolean
            sticky: boolean
            dotAll: boolean
            hasIndices: boolean
            unicodeSets: boolean
        },
    ): void {
        this._flags = {
            type: "Flags",
            parent: null,
            start,
            end,
            raw: this.source.slice(start, end),
            global,
            ignoreCase,
            multiline,
            unicode,
            sticky,
            dotAll,
            hasIndices,
            unicodeSets,
        }
    }

    public onPatternEnter(start: number): void {
        this._node = {
            type: "Pattern",
            parent: null,
            start,
            end: start,
            raw: "",
            alternatives: [],
        }
        this._backreferences.length = 0
        this._capturingGroups.length = 0
    }

    public onPatternLeave(start: number, end: number): void {
        this._node.end = end
        this._node.raw = this.source.slice(start, end)

        for (const reference of this._backreferences) {
            const ref = reference.ref
            const group =
                typeof ref === "number"
                    ? this._capturingGroups[ref - 1]
                    : this._capturingGroups.find((g) => g.name === ref)!
            reference.resolved = group
            group.references.push(reference)
        }
    }

    public onAlternativeEnter(start: number): void {
        const parent = this._node
        if (
            parent.type !== "Assertion" &&
            parent.type !== "CapturingGroup" &&
            parent.type !== "Group" &&
            parent.type !== "Pattern"
        ) {
            throw new Error("UnknownError")
        }

        this._node = {
            type: "Alternative",
            parent,
            start,
            end: start,
            raw: "",
            elements: [],
        }
        parent.alternatives.push(this._node)
    }

    public onAlternativeLeave(start: number, end: number): void {
        const node = this._node
        if (node.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        node.end = end
        node.raw = this.source.slice(start, end)
        this._node = node.parent
    }

    public onGroupEnter(start: number): void {
        const parent = this._node
        if (parent.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        this._node = {
            type: "Group",
            parent,
            start,
            end: start,
            raw: "",
            alternatives: [],
        }
        parent.elements.push(this._node)
    }

    public onGroupLeave(start: number, end: number): void {
        const node = this._node
        if (node.type !== "Group" || node.parent.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        node.end = end
        node.raw = this.source.slice(start, end)
        this._node = node.parent
    }

    public onCapturingGroupEnter(start: number, name: string | null): void {
        const parent = this._node
        if (parent.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        this._node = {
            type: "CapturingGroup",
            parent,
            start,
            end: start,
            raw: "",
            name,
            alternatives: [],
            references: [],
        }
        parent.elements.push(this._node)
        this._capturingGroups.push(this._node)
    }

    public onCapturingGroupLeave(start: number, end: number): void {
        const node = this._node
        if (
            node.type !== "CapturingGroup" ||
            node.parent.type !== "Alternative"
        ) {
            throw new Error("UnknownError")
        }

        node.end = end
        node.raw = this.source.slice(start, end)
        this._node = node.parent
    }

    public onQuantifier(
        start: number,
        end: number,
        min: number,
        max: number,
        greedy: boolean,
    ): void {
        const parent = this._node
        if (parent.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        // Replace the last element.
        const element = parent.elements.pop()
        if (
            element == null ||
            element.type === "Quantifier" ||
            (element.type === "Assertion" && element.kind !== "lookahead")
        ) {
            throw new Error("UnknownError")
        }

        const node: Quantifier = {
            type: "Quantifier",
            parent,
            start: element.start,
            end,
            raw: this.source.slice(element.start, end),
            min,
            max,
            greedy,
            element,
        }
        parent.elements.push(node)
        element.parent = node
    }

    public onLookaroundAssertionEnter(
        start: number,
        kind: "lookahead" | "lookbehind",
        negate: boolean,
    ): void {
        const parent = this._node
        if (parent.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        const node: LookaroundAssertion = (this._node = {
            type: "Assertion",
            parent,
            start,
            end: start,
            raw: "",
            kind,
            negate,
            alternatives: [],
        })
        parent.elements.push(node)
    }

    public onLookaroundAssertionLeave(start: number, end: number): void {
        const node = this._node
        if (node.type !== "Assertion" || node.parent.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        node.end = end
        node.raw = this.source.slice(start, end)
        this._node = node.parent
    }

    public onEdgeAssertion(
        start: number,
        end: number,
        kind: "end" | "start",
    ): void {
        const parent = this._node
        if (parent.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        parent.elements.push({
            type: "Assertion",
            parent,
            start,
            end,
            raw: this.source.slice(start, end),
            kind,
        })
    }

    public onWordBoundaryAssertion(
        start: number,
        end: number,
        kind: "word",
        negate: boolean,
    ): void {
        const parent = this._node
        if (parent.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        parent.elements.push({
            type: "Assertion",
            parent,
            start,
            end,
            raw: this.source.slice(start, end),
            kind,
            negate,
        })
    }

    public onAnyCharacterSet(start: number, end: number, kind: "any"): void {
        const parent = this._node
        if (parent.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        parent.elements.push({
            type: "CharacterSet",
            parent,
            start,
            end,
            raw: this.source.slice(start, end),
            kind,
        })
    }

    public onEscapeCharacterSet(
        start: number,
        end: number,
        kind: "digit" | "space" | "word",
        negate: boolean,
    ): void {
        const parent = this._node
        if (parent.type !== "Alternative" && parent.type !== "CharacterClass") {
            throw new Error("UnknownError")
        }

        parent.elements.push({
            type: "CharacterSet",
            parent,
            start,
            end,
            raw: this.source.slice(start, end),
            kind,
            negate,
        })
    }

    public onUnicodePropertyCharacterSet(
        start: number,
        end: number,
        kind: "property",
        key: string,
        value: string | null,
        negate: boolean,
        strings: boolean,
    ): void {
        const parent = this._node
        if (parent.type !== "Alternative" && parent.type !== "CharacterClass") {
            throw new Error("UnknownError")
        }

        const base = {
            type: "CharacterSet",
            parent: null,
            start,
            end,
            raw: this.source.slice(start, end),
            kind,
            strings: null,
            key,
        } as const

        if (strings) {
            if (
                (parent.type === "CharacterClass" && !parent.unicodeSets) ||
                negate ||
                value !== null
            ) {
                throw new Error("UnknownError")
            }

            parent.elements.push({ ...base, parent, strings, value, negate })
        } else {
            parent.elements.push({ ...base, parent, strings, value, negate })
        }
    }

    public onCharacter(start: number, end: number, value: number): void {
        const parent = this._node
        if (
            parent.type !== "Alternative" &&
            parent.type !== "CharacterClass" &&
            parent.type !== "StringAlternative"
        ) {
            throw new Error("UnknownError")
        }

        parent.elements.push({
            type: "Character",
            parent,
            start,
            end,
            raw: this.source.slice(start, end),
            value,
        })
    }

    public onBackreference(
        start: number,
        end: number,
        ref: number | string,
    ): void {
        const parent = this._node
        if (parent.type !== "Alternative") {
            throw new Error("UnknownError")
        }

        const node: Backreference = {
            type: "Backreference",
            parent,
            start,
            end,
            raw: this.source.slice(start, end),
            ref,
            resolved: DUMMY_CAPTURING_GROUP,
        }
        parent.elements.push(node)
        this._backreferences.push(node)
    }

    public onCharacterClassEnter(
        start: number,
        negate: boolean,
        unicodeSets: boolean,
    ): void {
        const parent = this._node
        const base = {
            type: "CharacterClass" as const,
            parent,
            start,
            end: start,
            raw: "",
            unicodeSets,
            negate,
            elements: [],
        }
        if (parent.type === "Alternative") {
            const node: CharacterClass = {
                ...base,
                parent,
            }
            this._node = node
            parent.elements.push(node)
        } else if (
            parent.type === "CharacterClass" &&
            parent.unicodeSets &&
            unicodeSets
        ) {
            const node: UnicodeSetsCharacterClass = {
                ...base,
                parent,
                unicodeSets,
            }
            this._node = node
            parent.elements.push(node)
        } else {
            throw new Error("UnknownError")
        }
    }

    public onCharacterClassLeave(start: number, end: number): void {
        const node = this._node
        if (
            node.type !== "CharacterClass" ||
            (node.parent.type !== "Alternative" &&
                node.parent.type !== "CharacterClass")
        ) {
            throw new Error("UnknownError")
        }
        const parent = node.parent

        node.end = end
        node.raw = this.source.slice(start, end)
        this._node = parent

        const expression = this._expressionBufferMap.get(node)
        if (!expression) {
            return
        }
        if (node.elements.length > 0) {
            throw new Error("UnknownError")
        }
        this._expressionBufferMap.delete(node)

        // Replace with ExpressionCharacterClass.
        const newNode: ExpressionCharacterClass = {
            type: "ExpressionCharacterClass",
            parent,
            start: node.start,
            end: node.end,
            raw: node.raw,
            negate: node.negate,
            expression,
        }
        expression.parent = newNode
        if (node !== parent.elements.pop()) {
            throw new Error("UnknownError")
        }
        parent.elements.push(newNode)
    }

    public onCharacterClassRange(start: number, end: number): void {
        const parent = this._node
        if (parent.type !== "CharacterClass") {
            throw new Error("UnknownError")
        }

        // Replace the last three elements.
        const elements = parent.elements
        const max = elements.pop()
        if (!max || max.type !== "Character") {
            throw new Error("UnknownError")
        }
        if (!parent.unicodeSets) {
            const hyphen = elements.pop()
            if (
                !hyphen ||
                hyphen.type !== "Character" ||
                hyphen.value !== HYPHEN_MINUS
            ) {
                throw new Error("UnknownError")
            }
        }
        const min = elements.pop()
        if (!min || min.type !== "Character") {
            throw new Error("UnknownError")
        }

        const node: CharacterClassRange = {
            type: "CharacterClassRange",
            parent,
            start,
            end,
            raw: this.source.slice(start, end),
            min,
            max,
        }
        min.parent = node
        max.parent = node
        elements.push(node)
    }

    public onClassIntersection(start: number, end: number): void {
        const parent = this._node
        if (parent.type !== "CharacterClass" || !parent.unicodeSets) {
            throw new Error("UnknownError")
        }
        // Replace the last two elements.
        const right = parent.elements.pop()
        const left =
            this._expressionBufferMap.get(parent) ?? parent.elements.pop()
        if (
            !left ||
            !right ||
            left.type === "ClassSubtraction" ||
            (left.type !== "ClassIntersection" && !isClassSetOperand(left)) ||
            !isClassSetOperand(right)
        ) {
            throw new Error("UnknownError")
        }
        const node: ClassIntersection = {
            type: "ClassIntersection",
            parent:
                // Temporarily cast. We will actually replace it later in `onCharacterClassLeave`.
                parent as never as ExpressionCharacterClass,
            start,
            end,
            raw: this.source.slice(start, end),
            left,
            right,
        }
        left.parent = node
        right.parent = node
        this._expressionBufferMap.set(parent, node)
    }

    public onClassSubtraction(start: number, end: number): void {
        const parent = this._node
        if (parent.type !== "CharacterClass" || !parent.unicodeSets) {
            throw new Error("UnknownError")
        }
        // Replace the last two elements.
        const right = parent.elements.pop()
        const left =
            this._expressionBufferMap.get(parent) ?? parent.elements.pop()
        if (
            !left ||
            !right ||
            left.type === "ClassIntersection" ||
            (left.type !== "ClassSubtraction" && !isClassSetOperand(left)) ||
            !isClassSetOperand(right)
        ) {
            throw new Error("UnknownError")
        }
        const node: ClassSubtraction = {
            type: "ClassSubtraction",
            parent:
                // Temporarily cast. We will actually replace it later in `onCharacterClassLeave`.
                parent as never as ExpressionCharacterClass,
            start,
            end,
            raw: this.source.slice(start, end),
            left,
            right,
        }
        left.parent = node
        right.parent = node
        this._expressionBufferMap.set(parent, node)
    }

    public onClassStringDisjunctionEnter(start: number): void {
        const parent = this._node
        if (parent.type !== "CharacterClass" || !parent.unicodeSets) {
            throw new Error("UnknownError")
        }

        this._node = {
            type: "ClassStringDisjunction",
            parent,
            start,
            end: start,
            raw: "",
            alternatives: [],
        }
        parent.elements.push(this._node)
    }

    public onClassStringDisjunctionLeave(start: number, end: number): void {
        const node = this._node
        if (
            node.type !== "ClassStringDisjunction" ||
            node.parent.type !== "CharacterClass"
        ) {
            throw new Error("UnknownError")
        }

        node.end = end
        node.raw = this.source.slice(start, end)
        this._node = node.parent
    }

    public onStringAlternativeEnter(start: number): void {
        const parent = this._node
        if (parent.type !== "ClassStringDisjunction") {
            throw new Error("UnknownError")
        }

        this._node = {
            type: "StringAlternative",
            parent,
            start,
            end: start,
            raw: "",
            elements: [],
        }
        parent.alternatives.push(this._node)
    }

    public onStringAlternativeLeave(start: number, end: number): void {
        const node = this._node
        if (node.type !== "StringAlternative") {
            throw new Error("UnknownError")
        }

        node.end = end
        node.raw = this.source.slice(start, end)
        this._node = node.parent
    }
}

export namespace RegExpParser {
    /**
     * The options for RegExpParser construction.
     */
    export interface Options {
        /**
         * The flag to disable Annex B syntax. Default is `false`.
         */
        strict?: boolean

        /**
         * ECMAScript version. Default is `2024`.
         * - `2015` added `u` and `y` flags.
         * - `2018` added `s` flag, Named Capturing Group, Lookbehind Assertion,
         *   and Unicode Property Escape.
         * - `2019`, `2020`, and `2021` added more valid Unicode Property Escapes.
         * - `2022` added `d` flag.
         * - `2023` added more valid Unicode Property Escapes.
         * - `2024` added `v` flag.
         */
        ecmaVersion?: EcmaVersion
    }
}

export class RegExpParser {
    private _state: RegExpParserState

    private _validator: RegExpValidator

    /**
     * Initialize this parser.
     * @param options The options of parser.
     */
    public constructor(options?: RegExpParser.Options) {
        this._state = new RegExpParserState(options)
        this._validator = new RegExpValidator(this._state)
    }

    /**
     * Parse a regular expression literal. E.g. "/abc/g"
     * @param source The source code to parse.
     * @param start The start index in the source code.
     * @param end The end index in the source code.
     * @returns The AST of the given regular expression.
     */
    public parseLiteral(
        source: string,
        start = 0,
        end: number = source.length,
    ): RegExpLiteral {
        this._state.source = source
        this._validator.validateLiteral(source, start, end)
        const pattern = this._state.pattern
        const flags = this._state.flags
        const literal: RegExpLiteral = {
            type: "RegExpLiteral",
            parent: null,
            start,
            end,
            raw: source,
            pattern,
            flags,
        }
        pattern.parent = literal
        flags.parent = literal
        return literal
    }

    /**
     * Parse a regular expression flags. E.g. "gim"
     * @param source The source code to parse.
     * @param start The start index in the source code.
     * @param end The end index in the source code.
     * @returns The AST of the given flags.
     */
    public parseFlags(
        source: string,
        start = 0,
        end: number = source.length,
    ): Flags {
        this._state.source = source
        this._validator.validateFlags(source, start, end)
        return this._state.flags
    }

    /**
     * Parse a regular expression pattern. E.g. "abc"
     * @param source The source code to parse.
     * @param start The start index in the source code.
     * @param end The end index in the source code.
     * @param flags The flags.
     * @returns The AST of the given pattern.
     */
    public parsePattern(
        source: string,
        start?: number,
        end?: number,
        flags?: {
            unicode?: boolean
            unicodeSets?: boolean
        },
    ): Pattern
    /**
     * @deprecated Backward compatibility
     * Use object `flags` instead of boolean `uFlag`.
     *
     * @param source The source code to parse.
     * @param start The start index in the source code.
     * @param end The end index in the source code.
     * @param uFlag The flag to set unicode mode.
     * @returns The AST of the given pattern.
     */
    public parsePattern(
        source: string,
        start?: number,
        end?: number,
        uFlag?: boolean, // The unicode flag (backward compatibility).
    ): Pattern
    public parsePattern(
        source: string,
        start = 0,
        end: number = source.length,
        uFlagOrFlags:
            | boolean
            | {
                  unicode?: boolean
                  unicodeSets?: boolean
              }
            | undefined = undefined,
    ): Pattern {
        this._state.source = source
        this._validator.validatePattern(
            source,
            start,
            end,
            uFlagOrFlags as never,
        )
        return this._state.pattern
    }
}

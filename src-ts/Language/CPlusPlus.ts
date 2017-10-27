"use strict";

import { Map, OrderedMap, OrderedSet } from "immutable";

import { TypeScriptTargetLanguage } from "../TargetLanguage";
import {
    Type,
    TopLevels,
    PrimitiveType,
    NamedType,
    ClassType,
    UnionType,
    allClassesAndUnions,
    nullableFromUnion,
    matchType,
    removeNullFromUnion
} from "../Type";
import { Namespace, Name, DependencyName, Namer, funPrefixNamer } from "../Naming";
import { Sourcelike, maybeAnnotated } from "../Source";
import { anyTypeIssueAnnotation, nullTypeIssueAnnotation } from "../Annotation";
import {
    legalizeCharacters,
    camelCase,
    startWithLetter,
    isLetterOrUnderscore,
    isLetterOrUnderscoreOrDigit,
    stringEscape
} from "../Support";
import { RenderResult } from "../Renderer";
import { ConvenienceRenderer } from "../ConvenienceRenderer";

export default class CPlusPlusTargetLanguage extends TypeScriptTargetLanguage {
    constructor() {
        super("C++", ["c++", "cpp"], "cpp", []);
    }

    renderGraph(topLevels: TopLevels, optionValues: { [name: string]: any }): RenderResult {
        const renderer = new CPlusPlusRenderer(topLevels);
        return renderer.render();
    }
}

const namingFunction = funPrefixNamer(cppNameStyle);

const legalizeName = legalizeCharacters(isLetterOrUnderscoreOrDigit);

function cppNameStyle(original: string): string {
    const legalized = legalizeName(original);
    const cameled = camelCase(legalized);
    return startWithLetter(isLetterOrUnderscore, false, cameled);
}

const keywords = [
    "alignas",
    "alignof",
    "and",
    "and_eq",
    "asm",
    "atomic_cancel",
    "atomic_commit",
    "atomic_noexcept",
    "auto",
    "bitand",
    "bitor",
    "bool",
    "break",
    "case",
    "catch",
    "char",
    "char16_t",
    "char32_t",
    "class",
    "compl",
    "concept",
    "const",
    "constexpr",
    "const_cast",
    "continue",
    "co_await",
    "co_return",
    "co_yield",
    "decltype",
    "default",
    "delete",
    "do",
    "double",
    "dynamic_cast",
    "else",
    "enum",
    "explicit",
    "export",
    "extern",
    "false",
    "float",
    "for",
    "friend",
    "goto",
    "if",
    "import",
    "inline",
    "int",
    "long",
    "module",
    "mutable",
    "namespace",
    "new",
    "noexcept",
    "not",
    "not_eq",
    "nullptr",
    "operator",
    "or",
    "or_eq",
    "private",
    "protected",
    "public",
    "register",
    "reinterpret_cast",
    "requires",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "static_assert",
    "static_cast",
    "struct",
    "switch",
    "synchronized",
    "template",
    "this",
    "thread_local",
    "throw",
    "true",
    "try",
    "typedef",
    "typeid",
    "typename",
    "union",
    "unsigned",
    "using",
    "virtual",
    "void",
    "volatile",
    "wchar_t",
    "while",
    "xor",
    "xor_eq",
    "override",
    "final",
    "transaction_safe",
    "transaction_safe_dynamic"
];

class CPlusPlusRenderer extends ConvenienceRenderer {
    protected get forbiddenNamesForGlobalNamespace(): string[] {
        return keywords;
    }

    protected forbiddenForProperties(
        c: ClassType,
        classNamed: Name
    ): { names: Name[]; namespaces: Namespace[] } {
        return { names: [], namespaces: [this.globalNamespace] };
    }

    protected topLevelNameStyle(rawName: string): string {
        return cppNameStyle(rawName);
    }

    protected get namedTypeNamer(): Namer {
        return namingFunction;
    }

    protected get propertyNamer(): Namer {
        return namingFunction;
    }

    protected namedTypeToNameForTopLevel(type: Type): NamedType | null {
        // FIXME: implement this properly
        if (type.isNamedType()) {
            return type;
        }
        return null;
    }

    private emitBlock = (line: Sourcelike, withSemicolon: boolean, f: () => void): void => {
        this.emitLine(line, " {");
        this.indent(f);
        if (withSemicolon) {
            this.emitLine("};");
        } else {
            this.emitLine("}");
        }
    };

    private cppTypeInOptional = (nonNulls: OrderedSet<Type>): Sourcelike => {
        if (nonNulls.size === 1) {
            return this.cppType(nonNulls.first());
        }
        const typeList: Sourcelike = [];
        nonNulls.forEach((t: Type) => {
            if (typeList.length !== 0) {
                typeList.push(", ");
            }
            // FIXME: Do we need annotations here?
            typeList.push(this.cppType(t));
        });
        return ["boost::variant<", typeList, ">"];
    };

    private variantType = (u: UnionType, noOptional: boolean = false): Sourcelike => {
        const [hasNull, nonNulls] = removeNullFromUnion(u);
        if (nonNulls.size < 2) throw "Variant not needed for less than two types.";
        const variant = this.cppTypeInOptional(nonNulls);
        if (!hasNull || noOptional) {
            return variant;
        }
        return ["boost::optional<", variant, ">"];
    };

    // FIXME: support omitting annotations
    private cppType = (t: Type, withIssues: boolean = false): Sourcelike => {
        return matchType<Sourcelike>(
            t,
            anyType => maybeAnnotated(withIssues, anyTypeIssueAnnotation, "json"),
            nullType => maybeAnnotated(withIssues, nullTypeIssueAnnotation, "json"),
            boolType => "bool",
            integerType => "int64_t",
            doubleType => "double",
            stringType => "std::string",
            arrayType => ["std::vector<", this.cppType(arrayType.items, withIssues), ">"],
            classType => this.nameForNamedType(classType),
            mapType => ["std::map<std::string, ", this.cppType(mapType.values, withIssues), ">"],
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (!nullable) return this.nameForNamedType(unionType);
                return ["boost::optional<", this.cppType(nullable, withIssues), ">"];
            }
        );
    };

    private emitClass = (
        c: ClassType,
        className: Name,
        propertyNames: OrderedMap<string, Name>
    ): void => {
        this.emitBlock(["struct ", className], true, () => {
            propertyNames.forEach((name: Name, json: string) => {
                const propertyType = c.properties.get(json);
                this.emitLine(this.cppType(propertyType, true), " ", name, ";");
            });
        });
    };

    private emitClassFunctions = (
        c: ClassType,
        className: Name,
        propertyNames: OrderedMap<string, Name>
    ): void => {
        this.emitBlock(["void from_json(const json& j, ", className, "& x)"], false, () => {
            propertyNames.forEach((name: Name, json: string) => {
                const t = c.properties.get(json);
                if (t instanceof UnionType) {
                    const [hasNull, nonNulls] = removeNullFromUnion(t);
                    if (hasNull) {
                        this.emitLine(
                            "x.",
                            name,
                            " = get_optional<",
                            this.cppTypeInOptional(nonNulls),
                            '>(j, "',
                            stringEscape(json),
                            '");'
                        );
                        return;
                    }
                }
                const cppType = this.cppType(t);
                this.emitLine(
                    "x.",
                    name,
                    ' = j.at("',
                    stringEscape(json),
                    '").get<',
                    cppType,
                    ">();"
                );
            });
        });
        this.emitNewline();
        this.emitBlock(["void to_json(json& j, const ", className, "& x)"], false, () => {
            const args: Sourcelike = [];
            propertyNames.forEach((name: Name, json: string) => {
                if (args.length !== 0) {
                    args.push(", ");
                }
                args.push('{"', json, '", x.', name, "}");
            });
            this.emitLine("j = json{", args, "};");
        });
    };

    private emitUnionTypedefs = (u: UnionType, unionName: Name): void => {
        this.emitLine("typedef ", this.variantType(u), " ", unionName, ";");
    };

    private emitUnionFunctions = (u: UnionType, unionName: Name): void => {
        const functionForKind: [string, string][] = [
            ["bool", "is_boolean"],
            ["integer", "is_number_integer"],
            ["double", "is_number"],
            ["string", "is_string"],
            ["class", "is_object"],
            ["map", "is_object"],
            ["array", "is_array"]
        ];
        const [_, nonNulls] = removeNullFromUnion(u);
        // FIXME: Use cppTypeInOptional here.
        const variantType = this.variantType(u, true);
        this.emitBlock(["void from_json(const json& j, ", variantType, "& x)"], false, () => {
            let onFirst = true;
            for (const [kind, func] of functionForKind) {
                const t = u.members.find((t: Type) => t.kind === kind);
                if (t === undefined) continue;
                this.emitLine(onFirst ? "if" : "else if", " (j.", func, "())");
                this.indent(() => {
                    this.emitLine("x = j.get<", this.cppType(t), ">();");
                });
                onFirst = false;
            }
            this.emitLine('else throw "Could not deserialize";');
        });
        this.emitNewline();
        this.emitBlock(["void to_json(json& j, const ", variantType, "& x)"], false, () => {
            this.emitBlock("switch (x.which())", false, () => {
                let i = 0;
                nonNulls.forEach((t: Type) => {
                    this.emitLine("case ", i.toString(), ":");
                    this.indent(() => {
                        this.emitLine("j = boost::get<", this.cppType(t), ">(x);");
                        this.emitLine("break;");
                    });
                    i++;
                });
                this.emitLine('default: throw "This should not happen";');
            });
        });
    };

    protected emitSourceStructure(): void {
        this.emitLine('#include "json.hpp"');
        this.forEachNamedType(
            "leading-and-interposing",
            true,
            this.emitClass,
            this.emitUnionTypedefs
        );
        this.forEachClass("leading-and-interposing", this.emitClassFunctions);
        this.emitNewline();
        this.emitBlock(["namespace nlohmann"], false, () => {
            this.forEachUnion("interposing", this.emitUnionFunctions);
        });
    }
}

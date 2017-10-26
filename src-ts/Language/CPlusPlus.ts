"use strict";

import { Map, OrderedMap } from "immutable";

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

class CPlusPlusRenderer extends ConvenienceRenderer {
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

    private emitClassForward = (
        c: ClassType,
        className: Name,
        propertyNames: OrderedMap<string, Name>
    ): void => {
        this.emitLine(["struct ", className, ";"]);
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
                const cppType = this.cppType(c.properties.get(json));
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

    private variantType = (u: UnionType, noOptional: boolean = false): Sourcelike => {
        const [hasNull, nonNulls] = removeNullFromUnion(u);
        const typeList: Sourcelike = [];
        nonNulls.forEach((t: Type) => {
            if (typeList.length !== 0) {
                typeList.push(", ");
            }
            typeList.push(this.cppType(t));
        });
        const variant: Sourcelike = ["boost::variant<", typeList, ">"];
        if (!hasNull || noOptional) {
            return variant;
        }
        return ["boost::optional<", variant, ">"];
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
        /*
    void to_json(json& j, const intOrString& x) {
        switch (x.which()) {
            case 0:
                j = boost::get<int64_t>(x);
                break;
            case 1:
                j = boost::get<std::string>(x);
                break;
            default:
                throw "This should not happen";
        }
    }
*/
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
        this.forEachClass("leading", this.emitClassForward);
        this.forEachUnion("leading", this.emitUnionTypedefs);
        this.forEachClass("leading-and-interposing", this.emitClass);
        this.forEachClass("leading-and-interposing", this.emitClassFunctions);
        this.emitNewline();
        this.emitBlock(["namespace nlohmann"], false, () => {
            this.forEachUnion("interposing", this.emitUnionFunctions);
        });
    }
}

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
    matchTypeAll,
    removeNullFromUnion
} from "../Type";
import { Namespace, Name, DependencyName, Namer, funPrefixNamer } from "../Naming";
import { Sourcelike, annotated } from "../Source";
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

    private cppType: (t: Type) => Sourcelike = matchTypeAll<Sourcelike>(
        anyType => annotated(anyTypeIssueAnnotation, "json"),
        nullType => annotated(nullTypeIssueAnnotation, "json"),
        boolType => "bool",
        integerType => "int64_t",
        doubleType => "double",
        stringType => "std::string",
        arrayType => ["std::vector<", this.cppType(arrayType.items), ">"],
        classType => this.nameForNamedType(classType),
        mapType => ["std::map<std::string, ", this.cppType(mapType.values), ">"],
        unionType => {
            const nullable = nullableFromUnion(unionType);
            if (!nullable) return "FIXME";
            return ["std::unique_ptr<", this.cppType(nullable), ">"];
        }
    );

    private emitClass = (
        c: ClassType,
        className: Name,
        propertyNames: OrderedMap<string, Name>
    ): void => {
        this.emitBlock(["struct ", className], true, () => {
            propertyNames.forEach((name: Name, json: string) => {
                const propertyType = c.properties.get(json);
                this.emitLine(this.cppType(propertyType), " ", name, ";");
            });
        });
    };

    protected emitSourceStructure(): void {
        this.emitLine('#include "json.hpp"');
        this.forEachClass("leading-and-interposing", this.emitClass);
    }
}

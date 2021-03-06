"use strict";

import { List } from "immutable";

import * as Either from "Data.Either";

import { Config } from "Config";
import * as Main from "Main";
import { Renderer } from "Doc";
import { fromLeft, fromRight } from "./purescript";
import { TopLevels } from "./Type";
import { RenderResult } from "./Renderer";
import { OptionDefinition } from "./RendererOptions";
import { glueGraphToNative } from "./Glue";
import { serializeRenderResult, SerializedRenderResult } from "./Source";

export abstract class TargetLanguage {
    constructor(
        readonly displayName: string,
        readonly names: string[],
        readonly extension: string,
        readonly optionDefinitions: OptionDefinition[]
    ) {}

    abstract transformAndRenderConfig(config: Config): SerializedRenderResult;
}

export abstract class TypeScriptTargetLanguage extends TargetLanguage {
    transformAndRenderConfig(config: Config): SerializedRenderResult {
        const glueGraphOrError = Main.glueGraphFromJsonConfig(config);
        if (Either.isLeft(glueGraphOrError)) {
            throw `Error processing JSON: ${fromLeft(glueGraphOrError)}`;
        }
        const glueGraph = fromRight(glueGraphOrError);
        const graph = glueGraphToNative(glueGraph);
        const renderResult = this.renderGraph(graph, config.rendererOptions);
        return serializeRenderResult(renderResult, this.indentation);
    }

    protected get indentation(): string {
        return "    ";
    }

    protected abstract renderGraph(
        topLevels: TopLevels,
        optionValues: { [name: string]: any }
    ): RenderResult;
}

function optionDefinitionsForRenderer(renderer: Renderer): OptionDefinition[] {
    return renderer.options.map(o => {
        return {
            name: o.name,
            description: o.description,
            typeLabel: o.typeLabel,
            renderer: true,
            type: String as any
        } as OptionDefinition;
    });
}

export class PureScriptTargetLanguage extends TargetLanguage {
    constructor(renderer: Renderer) {
        const optionDefinitions = optionDefinitionsForRenderer(renderer);
        super(renderer.displayName, renderer.names, renderer.extension, optionDefinitions);
    }

    transformAndRenderConfig(config: Config): SerializedRenderResult {
        const resultOrError = Main.main(config);
        if (Either.isLeft(resultOrError)) {
            throw `Error processing JSON: ${fromLeft(resultOrError)}`;
        }
        const source = fromRight(resultOrError);
        return { lines: source.split("\n"), annotations: List() };
    }
}

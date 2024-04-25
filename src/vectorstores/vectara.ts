import * as uuid from "uuid";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { VectorStore } from "@langchain/core/vectorstores";
import {
  BaseCallbackConfig,
  Callbacks,
} from "@langchain/core/callbacks/manager";
import { FakeEmbeddings } from "@langchain/core/utils/testing";

/**
 * Interface for the arguments required to initialize a VectaraStore
 * instance.
 */
export interface VectaraLibArgs {
  customerId: number;
  corpusId: number | number[];
  apiKey: string;
  verbose?: boolean;
  source?: string;
}

/**
 * Interface for the headers required for Vectara API calls.
 */
interface VectaraCallHeader {
  headers: {
    "x-api-key": string;
    "Content-Type": string;
    "customer-id": string;
    "X-Source": string;
  };
}

/**
 * Interface for the file objects to be uploaded to Vectara.
 */
export interface VectaraFile {
  // The contents of the file to be uploaded.
  blob: Blob;
  // The name of the file to be uploaded.
  fileName: string;
}

/**
 * Interface for the context configuration used in Vectara API calls.
 */
export interface VectaraContextConfig {
  // The amount of context before. Ignored if sentences_before is set.
  charsBefore?: number;
  // The amount of context after. Ignored if sentences_after is set.
  charsAfter?: number;
  // The amount of context before, in sentences.
  sentencesBefore?: number;
  // The amount of context after, in sentences.
  sentencesAfter?: number;
  // The tag that wraps the snippet at the start.
  startTag?: string;
  // The tag that wraps the snippet at the end.
  endTag?: string;
}

export interface MMRConfig {
  enabled?: boolean;
  mmrTopK?: number;
  diversityBias?: number;
}

export interface VectaraSummary {
  // Whether to enable summarization.
  enabled: boolean;
  // The name of the summarizer+prompt combination to use for summarization.
  summarizerPromptName?: string;
  // Maximum number of results to summarize.
  maxSummarizedResults: number;
  // ISO 639-1 or ISO 639-3 language code for the response, or "auto" to indicate that
  // the auto-detected language of the incoming query should be used.
  responseLang: string;
}

// VectaraFilter holds all the arguments for result retrieval by Vectara
// It's not really a filter, but a collection of arguments for the Vectara API
// However, it's been named "XXXFilter" in other places, so we keep the name here for consistency.
export interface VectaraFilter extends BaseCallbackConfig {
  // The start position in the result set
  start?: number;
  // Example of a vectara filter string can be: "doc.rating > 3.0 and part.lang = 'deu'"
  // See https://docs.vectara.com/docs/search-apis/sql/filter-overview for more details.
  filter?: string;
  // Improve retrieval accuracy using Hybrid search, by adjusting the value of lambda (0...1)
  // between neural search and keyword-based search factors. Values between 0.01 and 0.2 tend to work well.
  // see https://docs.vectara.com/docs/api-reference/search-apis/lexical-matching for more details.
  lambda?: number;
  // See Vectara Search API docs for more details on the following options: https://docs.vectara.com/docs/api-reference/search-apis/search
  contextConfig?: VectaraContextConfig;
  mmrConfig?: MMRConfig;
}

export const DEFAULT_FILTER: VectaraFilter = {
  start: 0,
  filter: "",
  lambda: 0.0,
  contextConfig: {
    sentencesBefore: 2,
    sentencesAfter: 2,
    startTag: "<b>",
    endTag: "</b>",
  },
  mmrConfig: {
    enabled: false,
    mmrTopK: 0,
    diversityBias: 0.0,
  },
};

interface SummaryResult {
  documents: Document[];
  scores: number[];
  summary: string;
}

export interface VectaraRetrieverInput {
  vectara: VectaraStore;
  topK: number;
  summaryConfig?: VectaraSummary;
  callbacks?: Callbacks;
  tags?: string[];
  metadata?: Record<string, unknown>;
  verbose?: boolean;
}
/**
 * Class for interacting with the Vectara API. Extends the VectorStore
 * class.
 */
export class VectaraStore extends VectorStore {
  get lc_secrets(): { [key: string]: string } {
    return {
      apiKey: "VECTARA_API_KEY",
      corpusId: "VECTARA_CORPUS_ID",
      customerId: "VECTARA_CUSTOMER_ID",
    };
  }

  get lc_aliases(): { [key: string]: string } {
    return {
      apiKey: "vectara_api_key",
      corpusId: "vectara_corpus_id",
      customerId: "vectara_customer_id",
    };
  }

  declare FilterType: VectaraFilter;

  private apiEndpoint = "api.vectara.io";

  private apiKey: string;

  private corpusId: number[];

  private customerId: number;

  private verbose: boolean;

  private source: string;

  private vectaraApiTimeoutSeconds = 60;

  _vectorstoreType(): string {
    return "vectara";
  }

  constructor(args: VectaraLibArgs) {
    // Vectara doesn't need embeddings, but we need to pass something to the parent constructor
    // The embeddings are abstracted out from the user in Vectara.
    super(new FakeEmbeddings(), args);

    const apiKey = args.apiKey ?? getEnvironmentVariable("VECTARA_API_KEY");
    if (!apiKey) {
      throw new Error("Vectara api key is not provided.");
    }
    this.apiKey = apiKey;
    this.source = args.source ?? "langchainjs";

    const corpusId =
      args.corpusId ??
      getEnvironmentVariable("VECTARA_CORPUS_ID")
        ?.split(",")
        .map((id) => {
          const num = Number(id);
          if (Number.isNaN(num))
            throw new Error("Vectara corpus id is not a number.");
          return num;
        });
    if (!corpusId) {
      throw new Error("Vectara corpus id is not provided.");
    }

    if (typeof corpusId === "number") {
      this.corpusId = [corpusId];
    } else {
      if (corpusId.length === 0)
        throw new Error("Vectara corpus id is not provided.");
      this.corpusId = corpusId;
    }

    const customerId =
      args.customerId ?? getEnvironmentVariable("VECTARA_CUSTOMER_ID");
    if (!customerId) {
      throw new Error("Vectara customer id is not provided.");
    }
    this.customerId = customerId;

    this.verbose = args.verbose ?? false;
  }

  /**
   * Returns a header for Vectara API calls.
   * @returns A Promise that resolves to a VectaraCallHeader object.
   */
  async getJsonHeader(): Promise<VectaraCallHeader> {
    return {
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
        "customer-id": this.customerId.toString(),
        "X-Source": this.source,
      },
    };
  }

  /**
   * Throws an error, as this method is not implemented. Use addDocuments
   * instead.
   * @param _vectors Not used.
   * @param _documents Not used.
   * @returns Does not return a value.
   */
  async addVectors(
    _vectors: number[][],
    _documents: Document[]
  ): Promise<void> {
    throw new Error(
      "Method not implemented. Please call addDocuments instead."
    );
  }

  /**
   * Method to delete data from the Vectara corpus.
   * @param params an array of document IDs to be deleted
   * @returns Promise that resolves when the deletion is complete.
   */
  async deleteDocuments(ids: string[]): Promise<void> {
    if (ids && ids.length > 0) {
      const headers = await this.getJsonHeader();
      for (const id of ids) {
        const data = {
          customer_id: this.customerId,
          corpus_id: this.corpusId[0],
          document_id: id,
        };

        try {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            this.vectaraApiTimeoutSeconds * 1000
          );
          const response = await fetch(
            `https://${this.apiEndpoint}/v1/delete-doc`,
            {
              method: "POST",
              headers: headers?.headers,
              body: JSON.stringify(data),
              signal: controller.signal,
            }
          );
          clearTimeout(timeout);
          if (response.status !== 200) {
            throw new Error(
              `Vectara API returned status code ${response.status} when deleting document ${id}`
            );
          }
        } catch (e) {
          const error = new Error(`Error ${(e as Error).message}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (error as any).code = 500;
          throw error;
        }
      }
    } else {
      throw new Error(`no "ids" specified for deletion`);
    }
  }

  /**
   * Adds documents to the Vectara store.
   * @param documents An array of Document objects to add to the Vectara store.
   * @returns A Promise that resolves to an array of document IDs indexed in Vectara.
   */
  async addDocuments(documents: Document[]): Promise<string[]> {
    if (this.corpusId.length > 1)
      throw new Error("addDocuments does not support multiple corpus ids");

    const headers = await this.getJsonHeader();
    const doc_ids: string[] = [];
    let countAdded = 0;
    for (const document of documents) {
      const doc_id: string = document.metadata?.document_id ?? uuid.v4();
      const data = {
        customer_id: this.customerId,
        corpus_id: this.corpusId[0],
        document: {
          document_id: doc_id,
          title: document.metadata?.title ?? "",
          metadata_json: JSON.stringify(document.metadata ?? {}),
          section: [
            {
              text: document.pageContent,
            },
          ],
        },
      };

      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.vectaraApiTimeoutSeconds * 1000
        );
        const response = await fetch(`https://${this.apiEndpoint}/v1/index`, {
          method: "POST",
          headers: headers?.headers,
          body: JSON.stringify(data),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const result = await response.json();
        if (
          result.status?.code !== "OK" &&
          result.status?.code !== "ALREADY_EXISTS"
        ) {
          const error = new Error(
            `Vectara API returned status code ${
              result.status?.code
            }: ${JSON.stringify(result.message)}`
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (error as any).code = 500;
          throw error;
        } else {
          countAdded += 1;
          doc_ids.push(doc_id);
        }
      } catch (e) {
        const error = new Error(
          `Error ${(e as Error).message} while adding document`
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (error as any).code = 500;
        throw error;
      }
    }
    if (this.verbose) {
      console.log(`Added ${countAdded} documents to Vectara`);
    }

    return doc_ids;
  }

  /**
   * Vectara provides a way to add documents directly via their API. This API handles
   * pre-processing and chunking internally in an optimal manner. This method is a wrapper
   * to utilize that API within LangChain.
   *
   * @param files An array of VectaraFile objects representing the files and their respective file names to be uploaded to Vectara.
   * @param metadata Optional. An array of metadata objects corresponding to each file in the `filePaths` array.
   * @returns A Promise that resolves to the number of successfully uploaded files.
   */
  async addFiles(
    files: VectaraFile[],
    metadatas: Record<string, unknown> | undefined = undefined
  ) {
    if (this.corpusId.length > 1)
      throw new Error("addFiles does not support multiple corpus ids");

    const doc_ids: string[] = [];

    for (const [index, file] of files.entries()) {
      const md = metadatas ? metadatas[index] : {};

      const data = new FormData();
      data.append("file", file.blob, file.fileName);
      data.append("doc-metadata", JSON.stringify(md));

      const response = await fetch(
        `https://api.vectara.io/v1/upload?c=${this.customerId}&o=${this.corpusId[0]}&d=true`,
        {
          method: "POST",
          headers: {
            "x-api-key": this.apiKey,
            "X-Source": this.source,
          },
          body: data,
        }
      );

      const { status } = response;
      if (status === 409) {
        throw new Error(`File at index ${index} already exists in Vectara`);
      } else if (status !== 200) {
        throw new Error(`Vectara API returned status code ${status}`);
      } else {
        const result = await response.json();
        const doc_id = result.document.documentId;
        doc_ids.push(doc_id);
      }
    }

    if (this.verbose) {
      console.log(`Uploaded ${files.length} files to Vectara`);
    }

    return doc_ids;
  }

  /**
   * Performs a Vectara API call based on the arguments provided.
   * @param query The query string for the similarity search.
   * @param k Optional. The number of results to return. Default is 10.
   * @param filter Optional. A VectaraFilter object to refine the search results.
   * @returns A Promise that resolves to an array of tuples, each containing a Document and its score.
   */
  async vectaraQuery(
    query: string,
    k: number,
    vectaraFilterObject: VectaraFilter,
    summary: VectaraSummary = {
      enabled: false,
      maxSummarizedResults: 0,
      responseLang: "eng",
    }
  ): Promise<SummaryResult> {
    const headers = await this.getJsonHeader();
    const { start, filter, lambda, contextConfig, mmrConfig } =
      vectaraFilterObject;

    const corpusKeys = this.corpusId.map((corpusId) => ({
      customerId: this.customerId,
      corpusId,
      metadataFilter: filter,
      lexicalInterpolationConfig: { lambda },
    }));

    const data = {
      query: [
        {
          query,
          start,
          numResults: mmrConfig?.enabled ? mmrConfig.mmrTopK : k,
          contextConfig,
          ...(mmrConfig?.enabled
            ? {
                rerankingConfig: {
                  rerankerId: 272725718,
                  mmrConfig: { diversityBias: mmrConfig.diversityBias },
                },
              }
            : {}),
          corpusKey: corpusKeys,
          ...(summary?.enabled ? { summary: [summary] } : {}),
        },
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.vectaraApiTimeoutSeconds * 1000
    );
    const response = await fetch(`https://${this.apiEndpoint}/v1/query`, {
      method: "POST",
      headers: headers?.headers,
      body: JSON.stringify(data),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.status !== 200) {
      throw new Error(`Vectara API returned status code ${response.status}`);
    }

    const result = await response.json();
    const responses = result.responseSet[0].response;
    const documents = result.responseSet[0].document;

    for (let i = 0; i < responses.length; i += 1) {
      const responseMetadata = responses[i].metadata;
      const documentMetadata = documents[responses[i].documentIndex].metadata;
      const combinedMetadata: Record<string, unknown> = {};

      responseMetadata.forEach((item: { name: string; value: unknown }) => {
        combinedMetadata[item.name] = item.value;
      });

      documentMetadata.forEach((item: { name: string; value: unknown }) => {
        combinedMetadata[item.name] = item.value;
      });

      responses[i].metadata = combinedMetadata;
    }

    const res: SummaryResult = {
      documents: responses.map(
        (response: {
          text: string;
          metadata: Record<string, unknown>;
          score: number;
        }) =>
          new Document({
            pageContent: response.text,
            metadata: response.metadata,
          })
      ),
      scores: responses.map(
        (response: {
          text: string;
          metadata: Record<string, unknown>;
          score: number;
        }) => response.score
      ),
      summary: result.responseSet[0].summary[0]?.text ?? "",
    };
    return res;
  }

  /**
   * Performs a similarity search and returns documents along with their
   * scores.
   * @param query The query string for the similarity search.
   * @param k Optional. The number of results to return. Default is 10.
   * @param filter Optional. A VectaraFilter object to refine the search results.
   * @returns A Promise that resolves to an array of tuples, each containing a Document and its score.
   */
  async similaritySearchWithScore(
    query: string,
    k?: number,
    filter?: VectaraFilter
  ): Promise<[Document, number][]> {
    const summaryResult = await this.vectaraQuery(
      query,
      k || 10,
      filter || DEFAULT_FILTER
    );
    const res = summaryResult.documents.map(
      (document, index) =>
        [document, summaryResult.scores[index]] as [Document, number]
    );
    return res;
  }

  /**
   * Performs a similarity search and returns documents.
   * @param query The query string for the similarity search.
   * @param k Optional. The number of results to return. Default is 10.
   * @param filter Optional. A VectaraFilter object to refine the search results.
   * @returns A Promise that resolves to an array of Document objects.
   */
  async similaritySearch(
    query: string,
    k?: number,
    filter?: VectaraFilter
  ): Promise<Document[]> {
    const documents = await this.similaritySearchWithScore(
      query,
      k || 10,
      filter || DEFAULT_FILTER
    );
    return documents.map((result) => result[0]);
  }

  /**
   * Throws an error, as this method is not implemented. Use
   * similaritySearch or similaritySearchWithScore instead.
   * @param _query Not used.
   * @param _k Not used.
   * @param _filter Not used.
   * @returns Does not return a value.
   */
  async similaritySearchVectorWithScore(
    _query: number[],
    _k: number,
    _filter?: VectaraFilter | undefined
  ): Promise<[Document, number][]> {
    throw new Error(
      "Method not implemented. Please call similaritySearch or similaritySearchWithScore instead."
    );
  }

  /**
   * Creates a VectaraStore instance from texts.
   * @param texts An array of text strings.
   * @param metadatas Metadata for the texts. Can be a single object or an array of objects.
   * @param _embeddings Not used.
   * @param args A VectaraLibArgs object for initializing the VectaraStore instance.
   * @returns A Promise that resolves to a VectaraStore instance.
   */
  static fromTexts(
    texts: string[],
    metadatas: object | object[],
    _embeddings: EmbeddingsInterface,
    args: VectaraLibArgs
  ): Promise<VectaraStore> {
    const docs: Document[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      const metadata = Array.isArray(metadatas) ? metadatas[i] : metadatas;
      const newDoc = new Document({
        pageContent: texts[i],
        metadata,
      });
      docs.push(newDoc);
    }

    return VectaraStore.fromDocuments(docs, new FakeEmbeddings(), args);
  }

  /**
   * Creates a VectaraStore instance from documents.
   * @param docs An array of Document objects.
   * @param _embeddings Not used.
   * @param args A VectaraLibArgs object for initializing the VectaraStore instance.
   * @returns A Promise that resolves to a VectaraStore instance.
   */
  static async fromDocuments(
    docs: Document[],
    _embeddings: EmbeddingsInterface,
    args: VectaraLibArgs
  ): Promise<VectaraStore> {
    const instance = new this(args);
    await instance.addDocuments(docs);
    return instance;
  }
}

import * as uuid from "uuid";
import { EmbeddingsInterface } from "@langchain/core/embeddings";
import { VectorStore } from "@langchain/core/vectorstores";
import { Index as UpstashIndex } from "@upstash/vector";
import { Document, DocumentInterface } from "@langchain/core/documents";
import { chunkArray } from "@langchain/core/utils/chunk_array";
import {
  AsyncCaller,
  AsyncCallerParams,
} from "@langchain/core/utils/async_caller";

/**
 * This interface defines the arguments for the UpstashVectorStore class.
 */
export interface UpstashVectorLibArgs extends AsyncCallerParams {
  index: UpstashIndex;
  filter?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UpstashMetadata = Record<string, any>;

export type UpstashQueryMetadata = UpstashMetadata & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _pageContentLC: any;
};

/**
 * Type that defines the parameters for the delete method.
 * It can either contain the target id(s) or the deleteAll config to reset all the vectors.
 */
export type UpstashDeleteParams =
  | {
      ids: string | string[];
      deleteAll?: never;
    }
  | { deleteAll: boolean; ids?: never };

const CONCURRENT_UPSERT_LIMIT = 1000;
/**
 * The main class that extends the 'VectorStore' class. It provides
 * methods for interacting with Upstash index, such as adding documents,
 * deleting documents, performing similarity search and more.
 */
export class UpstashVectorStore extends VectorStore {
  declare FilterType: string;

  index: UpstashIndex;

  caller: AsyncCaller;

  embeddings: EmbeddingsInterface;

  filter?: this["FilterType"];

  _vectorstoreType(): string {
    return "upstash";
  }

  constructor(embeddings: EmbeddingsInterface, args: UpstashVectorLibArgs) {
    super(embeddings, args);

    this.embeddings = embeddings;

    const { index, ...asyncCallerArgs } = args;

    this.index = index;
    this.caller = new AsyncCaller(asyncCallerArgs);
    this.filter = args.filter;
  }

  /**
   * This method adds documents to Upstash database. Documents are first converted to vectors
   * using the provided embeddings instance, and then upserted to the database.
   * @param documents Array of Document objects to be added to the database.
   * @param options Optional object containing array of ids for the documents.
   * @returns Promise that resolves with the ids of the provided documents when the upsert operation is done.
   */
  async addDocuments(
    documents: DocumentInterface[],
    options?: { ids?: string[] }
  ) {
    const texts = documents.map(({ pageContent }) => pageContent);

    const embeddings = await this.embeddings.embedDocuments(texts);

    return this.addVectors(embeddings, documents, options);
  }

  /**
   * This method adds the provided vectors to Upstash database.
   * @param vectors  Array of vectors to be added to the Upstash database.
   * @param documents Array of Document objects, each associated with a vector.
   * @param options Optional object containing the array of ids foor the vectors.
   * @returns Promise that resolves with the ids of the provided documents when the upsert operation is done.
   */
  async addVectors(
    vectors: number[][],
    documents: DocumentInterface[],
    options?: { ids?: string[] }
  ) {
    const documentIds =
      options?.ids ?? Array.from({ length: vectors.length }, () => uuid.v4());

    const upstashVectors = vectors.map((vector, index) => {
      const metadata = {
        _pageContentLC: documents[index].pageContent,
        ...documents[index].metadata,
      };

      const id = documentIds[index];

      return {
        id,
        vector,
        metadata,
      };
    });

    const vectorChunks = chunkArray(upstashVectors, CONCURRENT_UPSERT_LIMIT);

    const batchRequests = vectorChunks.map((chunk) =>
      this.caller.call(async () => this.index.upsert(chunk))
    );

    await Promise.all(batchRequests);

    return documentIds;
  }

  /**
   * This method deletes documents from the Upstash database. You can either
   * provide the target ids, or delete all vectors in the database.
   * @param params Object containing either array of ids of the documents or boolean deleteAll.
   * @returns Promise that resolves when the specified documents have been deleted from the database.
   */
  async delete(params: UpstashDeleteParams): Promise<void> {
    if (params.deleteAll) {
      await this.index.reset();
    } else if (params.ids) {
      await this.index.delete(params.ids);
    }
  }

  protected async _runUpstashQuery(
    query: number[],
    k: number,
    filter?: this["FilterType"],
    options?: { includeVectors: boolean }
  ) {
    const queryResult = await this.index.query<UpstashQueryMetadata>({
      vector: query,
      topK: k,
      includeMetadata: true,
      filter,
      ...options,
    });

    return queryResult;
  }

  /**
   * This method performs a similarity search in the Upstash database
   * over the existing vectors.
   * @param query Query vector for the similarity search.
   * @param k The number of similar vectors to return as result.
   * @returns Promise that resolves with an array of tuples, each containing
   *  Document object and similarity score. The length of the result will be
   *  maximum of 'k' and vectors in the index.
   */
  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
    filter?: this["FilterType"]
  ): Promise<[DocumentInterface, number][]> {
    const results = await this._runUpstashQuery(query, k, filter);

    const searchResult: [DocumentInterface, number][] = results.map((res) => {
      const { _pageContentLC, ...metadata } = (res.metadata ??
        {}) as UpstashQueryMetadata;
      return [
        new Document({
          metadata,
          pageContent: _pageContentLC,
        }),
        res.score,
      ];
    });

    return searchResult;
  }

  /**
   * This method creates a new UpstashVector instance from an array of texts.
   * The texts are initially converted to Document instances and added to Upstash
   * database.
   * @param texts The texts to create the documents from.
   * @param metadatas The metadata values associated with the texts.
   * @param embeddings Embedding interface of choice, to create the text embeddings.
   * @param dbConfig Object containing the Upstash database configs.
   * @returns Promise that resolves with a new UpstashVector instance.
   */
  static async fromTexts(
    texts: string[],
    metadatas: UpstashMetadata | UpstashMetadata[],
    embeddings: EmbeddingsInterface,
    dbConfig: UpstashVectorLibArgs
  ): Promise<UpstashVectorStore> {
    const docs: DocumentInterface[] = [];

    for (let i = 0; i < texts.length; i += 1) {
      const metadata = Array.isArray(metadatas) ? metadatas[i] : metadatas;
      const newDocument = new Document({
        pageContent: texts[i],
        metadata,
      });
      docs.push(newDocument);
    }

    return this.fromDocuments(docs, embeddings, dbConfig);
  }

  /**
   * This method creates a new UpstashVector instance from an array of Document instances.
   * @param docs The docs to be added to Upstash database.
   * @param embeddings Embedding interface of choice, to create the embeddings.
   * @param dbConfig Object containing the Upstash database configs.
   * @returns Promise that resolves with a new UpstashVector instance
   */
  static async fromDocuments(
    docs: DocumentInterface[],
    embeddings: EmbeddingsInterface,
    dbConfig: UpstashVectorLibArgs
  ): Promise<UpstashVectorStore> {
    const instance = new this(embeddings, dbConfig);
    await instance.addDocuments(docs);
    return instance;
  }

  /**
   * This method creates a new UpstashVector instance from an existing index.
   * @param embeddings Embedding interface of the choice, to create the embeddings.
   * @param dbConfig Object containing the Upstash database configs.
   * @returns
   */
  static async fromExistingIndex(
    embeddings: EmbeddingsInterface,
    dbConfig: UpstashVectorLibArgs
  ): Promise<UpstashVectorStore> {
    const instance = new this(embeddings, dbConfig);
    return instance;
  }
}

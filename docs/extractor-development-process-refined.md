# Google Search Results Extractor Development Process (Condensed Version)

This document outlines the core steps for going from analyzing Google search results HTML to implementing a reliable extractor.

## 1. Understand the Goal and Existing Code

*   **Goal**: Accurately extract titles, links, and snippet information from Google search results HTML.
*   **Starting Point**: Examine the structure of the target HTML files (e.g., `google-search-html/test_search-*.html`), and refer to the project's existing extraction logic (such as `src/search.ts`) to understand the basic requirements and current implementation.

## 2. Choose Analysis Tools

*   **Tool**: Use the `jsdom` library to simulate a browser DOM in a Node.js environment, so that you can programmatically query and analyze the HTML structure. This is the key tool for analyzing HTML.

## 3. Analyze the HTML Structure and Determine Selectors

*   **Analysis**: Use `jsdom` to write a script (such as `analyze-search-results.cjs`) to systematically inspect the HTML structure.
    *   **Probe Containers**: Identify the parent element that contains a single search result.
    *   **Locate Elements**: Locate the title, link, and snippet elements within the container.
    *   **Identify Patterns**: Find the most reliable combination of CSS selectors to uniquely identify these elements.
*   **Decision**: Based on the analysis results, determine the best combination of selectors to use for extraction.

## 4. Implement the Extraction Logic and Deduplication

*   **Implementation**: Based on the chosen selectors, write an extraction function (such as `extractSearchResults`).
    *   **Core Logic**: Iterate over all matching container elements, using the chosen selectors to extract the title, link, and snippet of each result.
    *   **Deduplication**: Implement a deduplication mechanism (for example, using a `Set` to store link URLs that have already been seen) to ensure the uniqueness of the results.
*   **Testing**: Write a test script (such as `test-extraction.cjs`) to verify the accuracy of the extraction logic and the effectiveness of the deduplication. Adjust based on the test results.

## 5. Package Into a Reusable Module

*   **Packaging**: Package the validated extraction logic into a standalone, reusable Node.js module (such as `google-search-extractor.cjs`).
*   **Interface**: Define a clear interface (for example, a function that accepts HTML and returns the extraction results) to make it easy to use within the project.

## 6. Integration and Usage

*   **Integration**: Import the packaged module into the main project (such as `search.ts`).
*   **Usage**: Wherever you need to extract Google search results, call the function provided by the module, pass in the HTML content, and obtain structured result data.
*   **Example**: You can create an example script (such as `integration-test.cjs`) to demonstrate how to integrate and use this module within the project.

This condensed process highlights the key steps from analysis to implementation, omitting the details of writing specific scripts, and focuses more on the methodology and the final deliverables.

const { BlobServiceClient } = require('@azure/storage-blob');
const fs = require('fs');
const path = require('path');

// Azure Blob Storage connection string
const blobName = "28-07-2024";
const localDirectory = path.join(__dirname, "28-07-2024");
const downloadFilePath = path.join(localDirectory, "out1.ts");

async function downloadBlob() {
  try {
    // Create a BlobServiceClient
    const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

    // Get a reference to the container and blob
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    console.log("-------------------------------------");
    // Download the blob
    console.log(`Downloading blob to ${downloadFilePath}`);
    const downloadBlockBlobResponse = await blobClient.download(0);
    const downloadedContent = await streamToBuffer(downloadBlockBlobResponse.readableStreamBody);

    // Ensure the directory exists
    if (!fs.existsSync(localDirectory)) {
      fs.mkdirSync(localDirectory, { recursive: true });
    }

    // Save the file to disk
    fs.writeFileSync(downloadFilePath, downloadedContent);
    console.log(`Download complete`);
  } catch (error) {
    console.error("Error downloading blob:", error.message);
  }
}

// Convert a readable stream to a buffer
async function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on('data', chunk => chunks.push(chunk));
    readableStream.on('end', () => resolve(Buffer.concat(chunks)));
    readableStream.on('error', reject);
  });
}

// Run the download function
// downloadBlob();



async function listBlobs() {
  try {
    // Create a BlobServiceClient
    const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

    // Get a reference to the container
    const containerClient = blobServiceClient.getContainerClient(containerName);

    console.log(`Listing blobs in container ${containerName}`);

    // List blobs
    let i = 1;
    for await (const blob of containerClient.listBlobsFlat()) {
      console.log(`${i++}: ${blob.name}`);
    }
  } catch (error) {
    console.error("Error listing blobs:", error.message);
  }
}

// Run the listBlobs function
 listBlobs();
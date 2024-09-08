const { BlobServiceClient } = require("@azure/storage-blob");
const fs = require('fs');
const path = require('path');

const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(containerName);

// Utility function to check if base folder already includes DEVICE_ID
function hasDeviceId(baseFolder) {
    return baseFolder.includes('DEVICE_ID');
}

async function uploadFolder(folderPath, baseFolder = '') {
    const items = fs.readdirSync(folderPath, { withFileTypes: true });
    
    for (const item of items) {
        const itemPath = path.join(folderPath, item.name);
        console.log("itempath----------", itemPath);

        if (item.isDirectory()) {
            const newBaseFolder = path.join(baseFolder, item.name);
            console.log("newBaseFolder----------", newBaseFolder);

            if (hasDeviceId(baseFolder) || item.name.startsWith("DEVICE_ID")) {
                await uploadFolder(itemPath, newBaseFolder);
            }
        } else if (item.isFile()) {
                       const blobName = path.join(baseFolder, item.name).replace(/\\/g, '/');
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);
            console.log(`========Uploading ${blobName}...`);
            await blockBlobClient.uploadFile(itemPath);
        }
    }
}

const deviceIdFolderPath = "D:\\HLS-withProperFolder\\DEVICE_ID1";
uploadFolder(deviceIdFolderPath).then(() => {
    console.log('Upload complete');
}).catch((error) => {
    console.error('Error uploading folder:', error);
});

uploadFolder("D:\\HLS-withProperFolder");

import React, { useState, useEffect, useRef, useCallback } from "react";
import { BrowserRouter as Router, Routes, Route, Link, Navigate, useNavigate } from "react-router-dom";
import {
  File as FileIcon, Folder as FolderIcon, Upload, Download, Edit, Trash2, Home, ChevronRight,
 Lock, Plus, X, ArrowLeft, ArrowRight, Menu, Mail, Map as MapIcon, MapPin
} from "lucide-react";
import { createClient } from "@supabase/supabase-js";

// ------- SUPABASE SETUP -------
const supabase = createClient(
  "https://barqwghiqazltkcnifxt.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhcnF3Z2hpcWF6bHRrY25pZnh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc5NTAxOTYsImV4cCI6MjA4MzUyNjE5Nn0.lx-Pdyl1mGJJ0mS7iP0gDUuUpTL9UgsLfqsa5HNBtNg"
);
const BUCKET = "documents";

//---------------------- Type Definitions ----------------------//
type TreeNode = {
  id: string;
  name: string;
  type: "file" | "folder";
  path: string;
  size?: number;
  lastModified?: string;
  mimetype?: string;
  children?: TreeNode[];
};

type Entry = {
  id: string;
  name: string;
  type: "file" | "folder";
  path: string;
  size?: number;
  lastModified?: string;
  mimetype?: string;
};


//---------------------- Utility Functions ----------------------//

const formatFileSize = (bytes: number) => {
  if (!bytes) return "";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

const SORT_OPTIONS = [
  { value: "name-asc", label: "Name (A-Z)" },
  { value: "name-desc", label: "Name (Z-A)" },
  { value: "date-desc", label: "Last Modified (Newest)" },
  { value: "date-asc", label: "Last Modified (Oldest)" },
  { value: "size-desc", label: "Size (Largest)" },
  { value: "size-asc", label: "Size (Smallest)" }
];

function getInitialSort() {
  return localStorage.getItem("adminDocsSort") || "date-desc";
}

function sanitizeName(name: string) {
  return name.replace(/[\\/]/g, "_");
}

// Utility: get the base name of a file (without extension)
function getBaseName(filename: string) {
  return filename.replace(/\.[^/.]+$/, "");
}

//---------------------- Supabase Folder/File Tree Helpers ----------------------//

// Helper to check if a file or folder exists
async function fileOrFolderExists(path: string): Promise<boolean> {
  const parent = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
  const name = path.split("/").pop();
  const { data, error } = await supabase.storage.from(BUCKET).list(parent, { limit: 1000 });
  if (error || !data) return false;
  return data.some(item => item.name === name);
}

async function listTree(prefix = ""): Promise<TreeNode[]> {
  let out: TreeNode[] = [];
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) {
    console.error("Supabase error:", error);
    return out;
  }
  const folderPromises: Promise<TreeNode[]>[] = [];
  for (const item of data || []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.metadata && item.metadata.mimetype) {
      out.push({
        id: path,
        name: item.name,
        type: "file",
        path,
        size: item.metadata.size,
        lastModified: item.updated_at,
        mimetype: item.metadata.mimetype
      });
    } else {
      // Instead of awaiting each, push to array
      folderPromises.push(listTree(path));
    }
  }
  // Wait for all folder listings at once
  const childrenArrays = await Promise.all(folderPromises);
  for (const children of childrenArrays) {
    out = out.concat(children);
  }
  return out;
}

function buildTree(files: TreeNode[]): TreeNode[] {
  const sep = "/";
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  files.forEach(f => {
    const parts = f.path.split("/").filter(Boolean);
    let currPath = "";
    let parent: TreeNode | undefined;
    for (let i = 0; i < parts.length; ++i) {
      currPath = currPath ? currPath + sep + parts[i] : parts[i];
      let node = map.get(currPath);
      if (!node) {
        node = {
          id: currPath,
          name: parts[i],
          type: (i === parts.length - 1 ? f.type : "folder"),
          path: currPath,
          ...(i === parts.length - 1 && f.type === "file"
            ? { size: f.size, lastModified: f.lastModified, mimetype: f.mimetype }
            : {})
        };
        map.set(currPath, node);
        if (parent) {
          parent.children = parent.children || [];
          parent.children.push(node);
        } else {
          roots.push(node);
        }
      }
      parent = node;
    }
  });

  // Prune .keep files from display, but folders still exist
  function pruneKeep(nodes: TreeNode[]): TreeNode[] {
    return nodes
      .map(n => n.type === "folder" && n.children
        ? { ...n, children: pruneKeep(n.children.filter(c => c.name !== ".keep")) }
        : n
      );
  }
  const tree = pruneKeep(roots);

  // Assign lastModified to folders = max(lastModified of all descendants)
  function assignFolderDates(nodes: TreeNode[]): string | undefined {
    for (const node of nodes) {
      if (node.type === "folder" && node.children && node.children.length > 0) {
        // Recursively assign dates to children first
        const childrenDates = node.children.map(c => assignFolderDates([c])).filter(Boolean);
        node.lastModified = childrenDates.length > 0
          ? childrenDates.sort().reverse()[0] // latest
          : undefined;
      }
    }
    // Return max lastModified in this level
    const dates = nodes.map(n => n.lastModified).filter(Boolean) as string[];
    return dates.length > 0 ? dates.sort().reverse()[0] : undefined;
  }
  assignFolderDates(tree);

  // Now sort by lastModified: Newest first, folders/files mixed or folders first
  function sortRecursive(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type === "folder" && b.type !== "folder") return -1;
      if (a.type !== "folder" && b.type === "folder") return 1;
      const aTime = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const bTime = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return bTime - aTime;
    });
    nodes.forEach(n => { if (n.children) sortRecursive(n.children); });
  }
  sortRecursive(tree);
  return tree;
}

async function uploadFile(path: string, file: File) {
  await supabase.storage.from(BUCKET).upload(path, file, { upsert: false });
}

// UPDATED: Prompt for overwrite if file exists
async function uploadFilesWithFolders(prefix: string, files: FileList | File[]) {
  for (const file of Array.from(files)) {
    let fullPath = (file as any).webkitRelativePath || file.name;
    if (prefix) fullPath = prefix + "/" + fullPath;
    if (await fileOrFolderExists(fullPath)) {
      if (!window.confirm(`File "${fullPath}" already exists. Do you want to replace it?`)) {
        continue;
      }
      await supabase.storage.from(BUCKET).remove([fullPath]);
    }
    await uploadFile(fullPath, file);
  }
}

async function deleteFileOrFolder(path: string, isFolder: boolean) {
  if (!isFolder) {
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    if (error) alert(`Failed to delete file: ${path}\n${error.message}`);
    return;
  }
  let filesToDelete: string[] = [];
  const gatherFiles = async (prefix: string) => {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
    if (error) {
      console.error("Supabase list error:", error, "for prefix:", prefix);
      return;
    }
    if (!data) return;
    for (const item of data) {
      const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.metadata && item.metadata.mimetype) {
        filesToDelete.push(itemPath);
      } else {
        if (item.name === ".keep") filesToDelete.push(itemPath);
        await gatherFiles(itemPath);
      }
    }
  };
  await gatherFiles(path);
  const { data: folderData } = await supabase.storage.from(BUCKET).list(path, { limit: 1000 });
  if (folderData && folderData.find(item => item.name === ".keep")) {
    filesToDelete.push(path + "/.keep");
  }
  if (filesToDelete.length === 0) return;
  const { error: delError } = await supabase.storage.from(BUCKET).remove(filesToDelete);
  if (delError) {
    alert("Some files could not be deleted: " + delError.message);
    console.error("Delete error:", delError, "Files:", filesToDelete);
  }
}

async function moveFileOrFolder(oldPath: string, newPath: string, isFolder = false) {
  if (oldPath === newPath) return;
  if (!isFolder) {
    const { data, error } = await supabase.storage.from(BUCKET).download(oldPath);
    if (!data || error) {
      alert("Failed to download file for renaming.");
      return;
    }
    await supabase.storage.from(BUCKET).remove([newPath]);
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(newPath, data, { upsert: true });
    if (uploadError) {
      alert("Failed to upload file to new name. Rename aborted.");
      return;
    }
    await supabase.storage.from(BUCKET).remove([oldPath]);
  } else {
    const { data: items, error } = await supabase.storage.from(BUCKET).list(oldPath, { limit: 1000 });
    if (error) return;
    for (const item of items || []) {
      const oldItemPath = oldPath + "/" + item.name;
      const newItemPath = newPath + "/" + item.name;
      if (item.metadata && item.metadata.mimetype) {
        const { data: fileData, error: downloadErr } = await supabase.storage.from(BUCKET).download(oldItemPath);
        if (fileData && !downloadErr) {
          await supabase.storage.from(BUCKET).remove([newItemPath]);
          const { error: uploadError } = await supabase.storage.from(BUCKET).upload(newItemPath, fileData, { upsert: true });
          if (!uploadError) {
            await supabase.storage.from(BUCKET).remove([oldItemPath]);
          }
        }
      } else {
        await moveFileOrFolder(oldItemPath, newItemPath, true);
      }
    }
    await supabase.storage.from(BUCKET).remove([oldPath]);
  }
}

//---------------------- ResponsiveNavbar ----------------------//
const ResponsiveNavbar = () => {
  const [open, setOpen] = useState(false);

  return (
    <nav className="bg-white/80 backdrop-blur shadow-lg rounded-xl mb-8 w-full">
      <div className="flex justify-between items-center p-4 md:p-6">
        <h1 className="text-2xl md:text-3xl font-extrabold text-blue-700 tracking-wide">CMPPL</h1>
        <button
          className="md:hidden"
          onClick={() => setOpen(!open)}
          aria-label="Menu"
        >
          {open ? <X className="h-7 w-7" /> : <Menu className="h-7 w-7" />}
        </button>
        <div className="hidden md:flex space-x-4">
          <Link to="/documents" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition"><FileIcon className="mr-2 h-5 w-5" />Documents</Link>
           <Link to="/track" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition">
            <MapIcon className="mr-2 h-5 w-5" />
            Track
          </Link>
          <Link to="/contact" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition"><Mail className="mr-2 h-5 w-5" />Contact Us</Link>
          <Link to="/admin/login" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition"><Lock className="mr-2 h-5 w-5" />Admin</Link>
        </div>
      </div>
      {open && (
        <div className="flex flex-col px-4 pb-4 space-y-1 md:hidden">
          <Link to="/documents" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition" onClick={() => setOpen(false)}><FileIcon className="mr-2 h-5 w-5" />Documents</Link>
          <Link to="/track" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition" onClick={() => setOpen(false)}>
            <MapIcon className="mr-2 h-5 w-5" />Track
          </Link>
          <Link to="/contact" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition" onClick={() => setOpen(false)}><Mail className="mr-2 h-5 w-5" />Contact Us</Link>
          <Link to="/admin/login" className="flex items-center px-3 py-2 rounded-md font-medium text-gray-700 hover:text-blue-700 hover:bg-blue-50 transition" onClick={() => setOpen(false)}><Lock className="mr-2 h-5 w-5" />Admin</Link>
        </div>
      )}
    </nav>
  );
};

//---------------------- Home Page ----------------------//
const HomePage = () => (
  <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4">
    <div className="max-w-4xl mx-auto">
      <ResponsiveNavbar />
      <div className="bg-white/90 rounded-2xl shadow-2xl p-8">
        <h2 className="text-2xl font-bold mb-4 text-blue-700">Welcome to CMPPL</h2>
        <p className="mb-2 text-gray-700">
          <span className="font-semibold">CMPPL</span> (Counto Microfine Products Pvt. Ltd.) is a joint venture company of Ambuja Cements Ltd and Alcon group Goa. It is pioneer in the country for patented micro fine mineral additives technology. It has one of the world’s biggest dedicated manufacturing facilities of micro fine materials at Goa.
        </p>
        <p className="text-gray-600">
          Our platform enables secure document sharing between users and administrators.
        </p>
      </div>
    </div>
  </div>
);

//---------------------- Contact Us Page ----------------------//
const ADDRESSES = [
  {
    label: "Marketing Office",
    lines: [
      "Ambuja Cements Ltd.",
      "Elegant business park,",
      "MIDC cross road B, JB Nagar, Andheri East,",
      "Mumbai, 400059",
      "Contact: +91 7030935351",
      "Email: alccofine.customercare@adani.com"
    ]
  },
  {
    label: "Factory Address",
    lines: [
      "Counto Microfine Products Pvt. Ltd.",
      "Plot No. 161-168, Pissurlem Industrial Estate"
      ,
      "Pissurlem Sattari Goa, 403530",
      "Contact: +91 9923593847"
    ]
  },
  {
    label: "Registered office/ CORPORATE OFFICE:",
    lines: [
      "Counto Microfine Products Pvt. Ltd.",
      "Fourth Floor, Alcon House,",
      "Chalta No.72, P.T. Sr. No.19,",
      "Near Sai Baba Temple,",
      "Kadamba Road, Panaji-Goa, 403006"
    ]
  }
];

const ContactUsPage = () => {

  return ( 
    <div className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-blue-100 via-blue-50 to-slate-200">
      {/* Decorative SVG Wave */}
      <div className="absolute top-0 left-0 w-full pointer-events-none z-0" style={{ height: '100px', minHeight: '60px' }}>
        <svg viewBox="0 0 1440 320" className="w-full h-full">
          <path fill="#3b82f6" fillOpacity="0.23" d="M0,256L60,245.3C120,235,240,213,360,213.3C480,213,600,235,720,229.3C840,224,960,192,1080,186.7C1200,181,1320,203,1380,213.3L1440,224L1440,0L1380,0C1320,0,1200,0,1080,0C960,0,840,0,720,0C600,0,480,0,360,0C240,0,120,0,60,0L0,0Z"></path>
        </svg>
      </div>
      <div className="relative z-10 w-full flex flex-col items-center justify-center pt-6 pb-2">
        <h2 className="text-2xl md:text-3xl font-extrabold text-blue-700 mb-5 drop-shadow text-center">Contact Us</h2>

        <div className="relative w-full max-w-md sm:max-w-lg mx-auto">
          <div className="absolute left-4 top-0 h-full w-0.5 bg-blue-200 rounded"></div>
          <div className="flex flex-col gap-6">
            {ADDRESSES.map((addr, idx) => (
              <div key={addr.label} className="relative flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div className="w-5 h-5 rounded-full bg-blue-100 border-2 border-blue-300 flex items-center justify-center shadow" />
                  {idx < ADDRESSES.length - 1 && (
                    <div className="flex-1 w-0.5 bg-blue-200 my-1" style={{ minHeight: 16 }}></div>
                  )}
                </div>
                <div className="bg-white/95 rounded-xl shadow-xl p-3 sm:p-4 border border-blue-100 w-full">
                  <h3 className="text-base sm:text-lg font-bold text-blue-700 mb-1">{addr.label}</h3>
                  <ul className="text-gray-600 text-xs sm:text-sm space-y-0.5">
                    {addr.lines.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Decorative Bottom SVG */}
      <div className="absolute bottom-0 left-0 w-full pointer-events-none z-0" style={{ height: '55px', minHeight: '40px' }}>
        <svg viewBox="0 0 1440 320" className="w-full h-full">
          <path fill="#3b82f6" fillOpacity="0.17" d="M0,32L120,37.3C240,43,480,53,720,53.3C960,53,1200,43,1320,37.3L1440,32L1440,320L1320,320C1200,320,960,320,720,320C480,320,240,320,120,320L0,320Z"></path>
        </svg>
      </div>
    </div>
  );
};

//---------------------- Track Page ----------------------//
const TrackPage = () => {
  const [region, setRegion] = useState<null | "South" | "West" | "East" | "North" | "Bangalore"| "Associated"| "Bulker"| "ARCL"| "Aditi Tracking">(null);
  const [AssociatedLinks, setAssociatedLinks] = useState<{ link: string; timestamp: string }[]>([]);
  const [isLoadingAssociated, setIsLoadingAssociated] = useState(false);
  const [AssociatedError, setAssociatedError] = useState<string | null>(null);
  const [arclLinks, setArclLinks] = useState<{ link: string; timestamp: string}[]>([]);
  const [isLoadingArcl, setIsLoadingArcl] = useState(false);
  const [arclError, setArclError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleRegionClick = (reg: "South" | "West" | "East" | "North") => setRegion(reg);
  const handleBack = () => setRegion(null);

  //---------Bangalore--------------//
  const fetchAssociatedLinks = async () => {
    setIsLoadingAssociated(true);
    setAssociatedError(null);
    try {
      const res = await fetch("https://script.google.com/macros/s/AKfycbzHpMFI1hxrEzlHy3ksIzalWGnxOd2xrcm38Nxxr9_ezcOOHf5SWpswMsFhLaHH6G26/exec");
      const data = await res.json();

       const links = Array.isArray(data)
        ? data.map((item: { link: string; timestamp: string }) => ({
            link: item.link,
            timestamp: item.timestamp
          }))
        : data.link && data.timestamp
          ? [{ link: data.link, timestamp: data.timestamp }]
          : [];

      setAssociatedLinks(links);
    } catch (error) {
      setAssociatedError("Failed to fetch Associated links");
      setAssociatedLinks([]);
    } finally {
      setIsLoadingAssociated(false);
    }
  };

  useEffect(() => {
    if (region === "Associated") {
      fetchAssociatedLinks();
    }
  }, [region]);

  useEffect(() => {
    if (region === "Associated") {
      const interval = setInterval(fetchAssociatedLinks, 5 * 60 * 1000);
      return () => clearInterval(interval);
    }
  }, [region]);

  //------------ARCL-------------//
  const fetchArclLinks = async () => {
    setIsLoadingArcl(true);
    setArclError(null);
    try {
      const res = await fetch("https://script.google.com/macros/s/AKfycbxC0GWULbwUvblezhQBeqeWroedHT22dD7b0ZIsmAQ5CkDlW1Rt8VC7c1hRZvuinzrG/exec");
      const data = await res.json();

       const links = Array.isArray(data)
        ? data.map((item: { link: string; timestamp: string }) => ({
            link: item.link,
            timestamp: item.timestamp
          }))
        : data.link && data.timestamp
          ? [{ link: data.link, timestamp: data.timestamp }]
          : [];

       setArclLinks(links);
    } catch (error) {
      setArclError("Failed to fetch ARCL links");
      setArclLinks([]);
    } finally {
      setIsLoadingArcl(false);
    }
  };

  useEffect(() => {
    if (region === "ARCL") {
      fetchArclLinks();
    }
  }, [region]);

  useEffect(() => {
    if (region === "ARCL") {
      const interval = setInterval(fetchArclLinks, 5 * 60 * 1000);
      return () => clearInterval(interval);
    }
  }, [region]);

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-blue-100 via-blue-50 to-slate-200 overflow-auto">
      <button
        onClick={() => navigate("/")}
        className="absolute top-5 left-5 text-blue-700 underline z-10"
      >
        ← Back to Home
      </button>

      {/* Decorative Top SVG */}
      <div className="absolute top-0 left-0 w-full pointer-events-none z-0" style={{ height: "90px", minHeight: "40px" }}>
        <svg viewBox="0 0 1440 320" className="w-full h-full">
          <path fill="#3b82f6" fillOpacity="0.15" d="M0,160L80,138.7C160,117,320,75,480,85.3C640,96,800,160,960,186.7C1120,213,1280,203,1360,197.3L1440,192L1440,0L1360,0C1280,0,1120,0,960,0C800,0,640,0,480,0C320,0,160,0,80,0L0,0Z" />
        </svg>
      </div>

      <div className="relative z-10 w-full flex flex-col items-center justify-center pt-8 pb-4">
        <div className="mb-2 animate-bounce-slow">
          <MapPin className="h-12 w-12 text-blue-500 drop-shadow" />
        </div>
        <h2 className="text-3xl font-extrabold text-blue-700 mb-1 drop-shadow text-center">Track</h2>
        <div className="mb-6 text-blue-800 text-opacity-80 text-lg font-medium text-center">
          Select a region to track your destination
        </div>

        <div className="relative w-full max-w-lg mx-auto flex flex-col items-center">
          {!region && (
            <div className="grid grid-cols-2 gap-6 w-full">
              {["East", "West", "North", "South"].map((regionName) => (
                <button
                  key={regionName}
                  onClick={() => handleRegionClick(regionName as any)}
                  className="bg-gradient-to-br from-blue-500 to-blue-400 hover:from-blue-600 hover:to-blue-500 text-white font-bold py-6 rounded-2xl shadow-xl transition transform hover:-translate-y-1 text-xl"
                  style={{ minWidth: 120 }}
                >
                  {regionName}
                </button>
              ))}
               <a
                href="http://clicktask.in"
                target="_blank"
                rel="noopener noreferrer"
                className="bg-gradient-to-br from-blue-500 to-blue-400 hover:from-blue-600 hover:to-blue-500 text-white font-bold py-6 rounded-2xl shadow-xl transition transform hover:-translate-y-1 text-xl text-center flex items-center justify-center"
                style={{ minWidth: 120 }}
              >
                Aditi Tracking
              </a>
            </div>
          )}

          {region === "South" && (
            <div className="animate-fadein flex flex-col items-center w-full mt-3">
              <button onClick={handleBack} className="text-blue-600 hover:underline mb-4 block text-left self-start">← Back</button>
              <div className="bg-white/95 border-l-8 border-blue-400 rounded-2xl shadow-2xl p-8 w-full flex flex-col items-center">
                <div className="mb-4 text-xl font-semibold text-blue-700">South Region</div>
                <div className="flex flex-wrap gap-6 justify-center">
                  <a
                    href="https://industry.roado.tech/trips/ongoing"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-green-500 hover:bg-green-600 text-white font-bold py-4 px-8 rounded-xl shadow transition text-lg"
                  >
                    Hyderabad
                  </a>
                  <button
                    onClick={() => setRegion("Bangalore")}
                    className="bg-green-500 hover:bg-green-600 text-white font-bold py-4 px-8 rounded-xl shadow transition text-lg"
                  >
                    Bangalore
                  </button>
                  <button
                    onClick={() => setRegion("Bulker")}
                    className="bg-green-500 hover:bg-green-600 text-white font-bold py-4 px-8 rounded-xl shadow transition text-lg"
                  >
                    Bulker
                  </button>
                </div>
              </div>
            </div>
          )}

          {region === "Bangalore" && (
          <div className="animate-fadein flex flex-col items-center w-full mt-3">
            <button onClick={handleBack} className="text-blue-600 hover:underline mb-4 block text-left self-start">← Back</button>
            <div className="bg-white/95 border-l-8 border-green-400 rounded-2xl shadow-2xl p-8 w-full flex flex-col items-center">
              <div className="mb-4 text-xl font-semibold text-green-700">Bangalore Tracking Links</div>
              <div className="flex flex-wrap gap-6 justify-center">
                <button
                  onClick={() => setRegion("Associated")}
                  className="bg-green-500 hover:bg-green-600 text-white font-bold py-4 px-8 rounded-xl shadow transition text-lg"
                >
                  Associated Logistics
                </button>
                <button
                  onClick={() => setRegion("ARCL")}
                  className="bg-green-500 hover:bg-green-600 text-white font-bold py-4 px-8 rounded-xl shadow transition text-lg"
                >
                  ARCL
                </button>
              </div>
            </div>
          </div>
        )}
          
          {region === "Associated" && (
            <div className="animate-fadein flex flex-col items-center w-full mt-3">
              <button onClick={handleBack} className="text-blue-600 hover:underline mb-4 block text-left self-start">← Back</button>
              <div className="bg-white/95 border-l-8 border-green-400 rounded-2xl shadow-2xl p-8 w-full flex flex-col items-center">
                <div className="mb-4 text-xl font-semibold text-green-700">Associated Logistics</div>
                {isLoadingAssociated ? (
                  <p className="text-gray-600">Loading...</p>
                ) : AssociatedError ? (
                  <p className="text-red-600">{AssociatedError}</p>
                ) : AssociatedLinks.length === 0 ? (
                  <p className="text-gray-500">No active links found.</p>
                ) : (
                  <div className="flex flex-col gap-3 w-full text-left">
                    {AssociatedLinks.map((item, i) => (
                      <div className="flex items-center justify-between flex-wrap gap-3">
                      <span className="text-sm text-gray-600 font-medium">
                     📅 {new Date(item.timestamp).toLocaleString("en-IN", {
                            day: "2-digit",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                           })}
                          </span>
                          <a
                            href={item.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-700 underline font-semibold"
                          >
                           🔗Link
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {region === "ARCL" && (
        <div className="animate-fadein flex flex-col items-center w-full mt-3">
          <button onClick={handleBack} className="text-blue-600 hover:underline mb-4 block text-left self-start">← Back</button>
          <div className="bg-white/95 border-l-8 border-green-400 rounded-2xl shadow-2xl p-8 w-full flex flex-col items-center">
            <div className="mb-4 text-xl font-semibold text-green-700">ARCL Tracking Links</div>
            {isLoadingArcl ? (
                  <p className="text-gray-600">Loading...</p>
                ) : arclError ? (
                  <p className="text-red-600">{arclError}</p>
                ) : arclLinks.length === 0 ? (
                  <p className="text-gray-500">No active links found.</p>
                ) : (
              <div className="flex flex-col gap-3 w-full text-left">
                {arclLinks.map((item, i) => (
                  <div
                    className="flex items-center justify-between flex-wrap gap-3"
                    key={`${item.link}-${i}`}
                  >
                    <span className="text-sm text-gray-600 font-medium">
                      📅 {new Date(item.timestamp).toLocaleString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-700 underline font-semibold"
                    >
                      🔗Link
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

          {region === "Bulker" && (
          <div className="animate-fadein flex flex-col items-center w-full mt-3">
            <button onClick={handleBack} className="text-blue-600 hover:underline mb-4 block text-left self-start">← Back</button>
            <div className="bg-white/95 border-l-8 border-green-400 rounded-2xl shadow-2xl p-8 w-full flex flex-col items-center">
              <div className="mb-4 text-xl font-semibold text-green-700">Bulker Tracking</div>
              <div className="flex flex-wrap gap-6 justify-center">
                <a
                  href="http://gpsmiles.live"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-green-500 hover:bg-green-600 text-white font-bold py-4 px-8 rounded-xl shadow transition text-lg"
                >
                  JFC, Alliance, Vettore
                </a>
              </div>
            </div>
          </div>
        )}

          {/* West Region */}
          {region === "West" && (
            <div className="animate-fadein flex flex-col items-center w-full mt-3">
              <button onClick={handleBack} className="text-blue-600 hover:underline mb-4 block text-left self-start">&larr; Back</button>
              <div className="bg-white/95 border-l-8 border-yellow-400 rounded-2xl shadow-2xl p-8 w-full flex flex-col items-center">
                <div className="mb-4 text-xl font-semibold text-yellow-600">West Region</div>
                <div className="flex flex-wrap gap-6 justify-center">
                <button className="bg-yellow-500 text-white font-bold py-4 px-8 rounded-xl shadow transition text-lg">Gujarat</button>
                <a
                  href="http://www.ilogistek.com/track/tracking.php" // <-- Replace with actual Maharashtra tracking URL
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-yellow-400 hover:bg-yellow-500 text-white font-bold py-4 px-8 rounded-xl shadow transition text-lg"
                >
                  Maharashtra
                </a>
              </div>
            </div>
          </div>
          )}

          {/* North Region */}
          {region === "North" && (
            <div className="animate-fadein flex flex-col items-center w-full mt-3">
              <button onClick={handleBack} className="text-blue-600 hover:underline mb-4 block text-left self-start">&larr; Back</button>
              <div className="bg-white/95 border-l-8 border-gray-400 rounded-2xl shadow-2xl p-8 w-full flex flex-col items-center">
                <div className="mb-4 text-xl font-semibold text-gray-600">North Region</div>
                <p className="text-gray-500">No options available yet.</p>
              </div>
            </div>
          )}

          {/* East Region */}
          {region === "East" && (
            <div className="animate-fadein flex flex-col items-center w-full mt-3">
              <button onClick={handleBack} className="text-blue-600 hover:underline mb-4 block text-left self-start">&larr; Back</button>
              <div className="bg-white/95 border-l-8 border-gray-400 rounded-2xl shadow-2xl p-8 w-full flex flex-col items-center">
                <div className="mb-4 text-xl font-semibold text-gray-600">East Region</div>
                <p className="text-gray-500">No options available yet.</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Decorative Bottom SVG */}
      <div className="absolute bottom-0 left-0 w-full pointer-events-none z-0" style={{ height: "60px", minHeight: "25px" }}>
        <svg viewBox="0 0 1440 320" className="w-full h-full">
          <path fill="#3b82f6" fillOpacity="0.13" d="M0,288L80,272C160,256,320,224,480,224C640,224,800,256,960,256C1120,256,1280,224,1360,208L1440,192L1440,320L1360,320C1280,320,1120,320,960,320C800,320,640,320,480,320C320,320,160,320,80,320L0,320Z" />
        </svg>
      </div>

      {/* Animations */}
      <style>
        {`
          .animate-fadein {
            animation: fadein 0.4s;
          }
          @keyframes fadein {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .animate-bounce-slow {
            animation: bounce 2.5s infinite;
          }
          @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-17px); }
          }
        `}
      </style>
    </div>
  );
};

//---------------------- Public Docs Login Page ----------------------//
const PublicDocsLogin = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  // Set/change your public credentials here:
  const PUBLIC_DOC_USERNAME = "Alccofine";
  const PUBLIC_DOC_PASSWORD = "Alccofine03";

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (username === PUBLIC_DOC_USERNAME && password === PUBLIC_DOC_PASSWORD) {
      localStorage.setItem('isPublicDocsAuthenticated', 'true');
      navigate('/documents');
    } else setError('Invalid username or password');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-slate-100 p-4">
      <form onSubmit={handleLogin} className="w-full max-w-md bg-white/95 rounded-2xl shadow-2xl p-8 space-y-5">
        <h2 className="text-2xl font-bold mb-3 text-center text-blue-700">Documents Login</h2>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)}
            className="w-full p-3 border-2 border-blue-100 rounded-lg" required />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            className="w-full p-3 border-2 border-blue-100 rounded-lg" required />
        </div>
        {error && <div className="text-red-500 text-sm">{error}</div>}
        <button type="submit"
          className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 px-4 rounded-lg font-semibold shadow transition">
          Login
        </button>
      </form>
    </div>
  );
};

//---------------------- Public Protected Route ----------------------//
const PublicProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const isAuthenticated = localStorage.getItem('isPublicDocsAuthenticated') === 'true';
  if (!isAuthenticated) {
    return <Navigate to="/documents/login" replace />;
  }
  return <>{children}</>;
};

//---------------------- DocumentsPage (Supabase, public, read-only) ----------------------//
const MONTHS = [
  ["jan", "january"],
  ["feb", "february"],
  ["mar", "march"],
  ["apr", "april"],
  ["may"],
  ["jun", "june"],
  ["jul", "july"],
  ["aug", "august"],
  ["sep", "september"],
  ["oct", "october"],
  ["nov", "november"],
  ["dec", "december"]
];

function getMonthIndex(name: string) {
  const lower = name.toLowerCase();
  for (let i = 0; i < MONTHS.length; ++i) {
    for (const variant of MONTHS[i]) {
      if (lower.startsWith(variant)) {
        // Next char must be non-letter or end of string
        const nextChar = lower.charAt(variant.length);
        if (!nextChar || /[^a-z]/.test(nextChar)) {
          return i;
        }
      }
    }
  }
  return -1;
}

function customSort(a: Entry, b: Entry) {
  // "intial" folders first
  const aIsIntial = a.type === "folder" && /intial/i.test(a.name);
  const bIsIntial = b.type === "folder" && /intial/i.test(b.name);
  if (aIsIntial && !bIsIntial) return -1;
  if (!aIsIntial && bIsIntial) return 1;

  // Month folders
  const aMonthIdx = a.type === "folder" ? getMonthIndex(a.name) : -1;
  const bMonthIdx = b.type === "folder" ? getMonthIndex(b.name) : -1;
  if (aMonthIdx !== -1 && bMonthIdx !== -1) {
    return aMonthIdx - bMonthIdx;
  }
  if (aMonthIdx !== -1) return -1;
  if (bMonthIdx !== -1) return 1;

  // "final" folders last
  const aIsFinal = a.type === "folder" && /final/i.test(a.name);
  const bIsFinal = b.type === "folder" && /final/i.test(b.name);
  if (aIsFinal && !bIsFinal) return 1;
  if (!aIsFinal && bIsFinal) return -1;

  // Folders before files
  if (a.type === "folder" && b.type !== "folder") return -1;
  if (a.type !== "folder" && b.type === "folder") return 1;

  // Default: alphabetical
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

// Utility to detect mobile devices
function isMobileDevice() {
  return /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
}

const DocumentsPage = () => {
  const [folderStack, setFolderStack] = useState<string[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState<string>("");
  const [viewDoc, setViewDoc] = useState<Entry | null>(null);

  const navigate = useNavigate();

  // Logout handler for public docs
  const handleLogout = () => {
    localStorage.removeItem('isPublicDocsAuthenticated');
    navigate("/");
  };

  const currentPrefix = folderStack.length ? folderStack[folderStack.length - 1] : "";

  const refresh = async () => {
    setLoading(true);
    const { data, error } = await supabase.storage.from(BUCKET).list(currentPrefix, { limit: 1000 });
    if (error || !data) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setEntries(
      data
        .filter(item => item.name !== ".keep")
        .map(item => ({
          id: currentPrefix ? `${currentPrefix}/${item.name}` : item.name,
          name: item.name,
          type: item.metadata && item.metadata.mimetype ? "file" : "folder",
          path: currentPrefix ? `${currentPrefix}/${item.name}` : item.name,
          size: item.metadata?.size,
          lastModified: item.updated_at,
          mimetype: item.metadata?.mimetype,
        }))
    );
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line
  }, [currentPrefix]);

  const filtered = entries.filter(entry =>
    search
      ? entry.name.toLowerCase().includes(search.toLowerCase())
      : true
  );

  const docsToShow = filtered.slice().sort(customSort);

  const handleFolderOpen = (entry: Entry) => {
    setFolderStack([...folderStack, entry.id]);
    setSearch("");
  };

  const handleUp = () => {
    setFolderStack(folderStack.slice(0, -1));
    setSearch("");
  };

  async function handleDownload(doc: Entry) {
    const { data, error } = await supabase.storage.from(BUCKET).download(doc.path);
    if (error || !data) {
      alert("Failed to download file.");
      return;
    }
    const url = window.URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      window.URL.revokeObjectURL(url);
      a.remove();
    }, 500);
  }

  function handleView(doc: Entry) {
    const url = supabase.storage.from(BUCKET).getPublicUrl(doc.path).data.publicUrl;
    if (isMobileDevice()) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      setViewDoc(doc);
    }
  }

  const renderDocViewer = (doc: Entry) => {
    const url = supabase.storage.from(BUCKET).getPublicUrl(doc.path).data.publicUrl;
    const ext = doc.name.split(".").pop()?.toLowerCase() || "";

    if (["png", "jpg", "jpeg", "gif", "bmp", "webp"].includes(ext)) {
      return <img src={url} alt={doc.name} className="max-h-[70vh] max-w-full mx-auto rounded shadow" />;
    }
    if (ext === "pdf") {
      return <iframe title={doc.name} src={url} className="w-full" style={{ minHeight: "70vh" }} />;
    }
    if (["txt", "md", "csv", "json", "log"].includes(ext)) {
      return (
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600">
          View Raw Text
        </a>
      );
    }
    if (["doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "ods", "odp"].includes(ext)) {
      const googleDocsUrl = `https://docs.google.com/gview?url=${encodeURIComponent(url)}&embedded=true`;
      return (
        <div>
          <iframe
            title={doc.name}
            src={googleDocsUrl}
            style={{ width: "100%", minHeight: "70vh", border: 0 }}
          ></iframe>
          <div className="mt-3">
            <a href={url} download={doc.name} className="text-blue-600 underline">
              Download {doc.name}
            </a>
          </div>
        </div>
      );
    }
    return (
      <div>
        <p>Cannot preview this file type.</p>
        <a href={url} download={doc.name} className="text-blue-600 underline">
          Download {doc.name}
        </a>
      </div>
    );
  };

  // Breadcrumbs
  const crumbs = [{ name: "Root", prefix: "" }];
  folderStack.forEach((id, idx) => {
    crumbs.push({
      name: id.split("/").pop() || id,
      prefix: id,
    });
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4 overflow-y-auto overflow-x-hidden w-full">
      <div className="max-w-3xl w-full mx-auto">
        <Link to="/" className="inline-flex items-center text-blue-600 mb-4 hover:underline">
          <Home className="mr-1 h-5 w-5" /> Back to Home
        </Link>
        <div className="bg-white/90 rounded-2xl shadow-2xl p-4 sm:p-6 w-full relative">
          {/* LOGOUT BUTTON INSIDE CARD */}
          <button
            onClick={handleLogout}
            className="absolute top-4 right-4 bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-2 rounded z-10"
          >
            Logout
          </button>
          <h2 className="text-2xl font-bold mb-4 flex items-center text-blue-700">
            <FolderIcon className="mr-2 h-6 w-6" /> Documents
          </h2>
          {/* Breadcrumbs */}
          <nav className="flex flex-wrap items-center mb-4 gap-y-1 overflow-x-hidden w-full">
            {crumbs.map((c, i) => (
              <span key={c.prefix} className="flex items-center min-w-0">
                <button
                  onClick={() => setFolderStack(folderStack.slice(0, i))}
                  className="text-blue-600 hover:underline font-bold truncate"
                  style={{ maxWidth: 120 }}
                >
                  {c.name}
                </button>
                {i < crumbs.length - 1 && (
                  <ChevronRight className="h-4 w-4 mx-1 text-gray-300" />
                )}
              </span>
            ))}
          </nav>
          {/* Up button */}
          {folderStack.length > 0 && (
            <button
              className="bg-gray-200 px-3 py-2 rounded-lg flex items-center gap-1 font-semibold shadow hover:bg-gray-300 transition mb-4"
              onClick={handleUp}
            >
              <ArrowLeft className="h-4 w-4" /> Back
            </button>
          )}
          <div className="flex items-center mb-4">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search documents..."
              className="border rounded px-3 py-2 w-full md:max-w-xs"
            />
            {loading && (
              <span className="ml-4 text-blue-600 animate-pulse font-medium">Loading...</span>
            )}
          </div>
          <div className="border rounded-xl p-4 bg-gray-50/60 w-full overflow-x-hidden">
            <ul className="divide-y divide-gray-200 mt-2">
              {docsToShow.map(entry =>
                entry.type === "folder" ? (
                  <li
                    key={entry.id}
                    className="flex items-center py-2 px-2 group cursor-pointer transition-all w-full min-w-0"
                    onClick={() => handleFolderOpen(entry)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={e => {
                      if (e.key === "Enter" || e.key === " ") handleFolderOpen(entry);
                    }}
                  >
                    <FolderIcon className="h-5 w-5 text-yellow-500 mr-1 flex-shrink-0" />
                    <span className="flex-1 font-medium text-xs break-words whitespace-normal min-w-0">
                      {entry.name}
                    </span>
                    {entry.lastModified && (
                      <span className="text-xs text-gray-400 whitespace-nowrap ml-2">
                        {new Date(entry.lastModified).toLocaleDateString()}
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 text-blue-500 flex-shrink-0 ml-1" />
                  </li>
                ) : (
                  <li
                    key={entry.id}
                    className="flex items-center py-2 px-2 group cursor-pointer transition-all w-full min-w-0"
                    onClick={() => handleView(entry)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={e => {
                      if (e.key === "Enter" || e.key === " ") handleView(entry);
                    }}
                  >
                    <FileIcon className="h-5 w-5 text-blue-500 mr-1 flex-shrink-0" />
                    <span className="flex-1 font-medium text-xs break-words whitespace-normal min-w-0">
                      {getBaseName(entry.name)}
                    </span>
                    {entry.lastModified && (
                      <span className="text-xs text-gray-400 whitespace-nowrap ml-2">
                        {new Date(entry.lastModified).toLocaleDateString()}
                      </span>
                    )}
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        handleDownload(entry);
                      }}
                      className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100 flex-shrink-0 ml-1"
                      tabIndex={-1}
                      title="Download"
                      type="button"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  </li>
                )
              )}
              {docsToShow.length === 0 && (
                <li className="text-gray-400 px-2 py-4">
                  {loading ? "Loading..." : "No documents available"}
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>
      {/* Only show the viewer on desktop */}
      {viewDoc && !isMobileDevice() && (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
          <div className="flex items-center p-4 bg-blue-700 shadow">
            <button
              className="mr-4 text-white flex items-center gap-2 font-bold text-lg"
              onClick={() => setViewDoc(null)}
            >
              <ArrowLeft className="h-6 w-6" /> Back
            </button>
            <span className="text-white font-semibold truncate">{getBaseName(viewDoc.name)}</span>
          </div>
          <div className="flex-1 p-0 overflow-auto flex justify-center items-center bg-black bg-opacity-5">
            <div className="w-full h-full flex items-center justify-center">
              {renderDocViewer(viewDoc)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

//---------------------- Admin Login Page ----------------------//
const AdminLogin = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (username === 'cmppl' && password === 'Alccofine1203') {
      localStorage.setItem('isAuthenticated', 'true');
      navigate('/admin');
    } else setError('Invalid username or password');
  };
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white/95 rounded-2xl shadow-2xl p-8">
        <h2 className="text-2xl font-bold mb-6 text-center text-blue-700">Admin Login</h2>
        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full p-3 border-2 border-blue-100 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-400 shadow-sm transition"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-3 border-2 border-blue-100 rounded-lg focus:ring-2 focus:ring-blue-300 focus:border-blue-400 shadow-sm transition"
              required
            />
          </div>
          {error && <div className="text-red-500 text-sm">{error}</div>}
          <button
            type="submit"
            className="w-full bg-gradient-to-tr from-blue-600 to-blue-400 hover:from-blue-700 hover:to-blue-500 text-white py-3 px-4 rounded-lg shadow-lg font-semibold transition"
          >
            Login
          </button>
        </form>
      </div>
    </div>
  );
};

//---------------------- Admin Dashboard Page ----------------------//
const AdminDashboard = () => {
  const navigate = useNavigate();
  const handleLogout = () => {
    localStorage.removeItem('isAuthenticated');
    navigate('/');
  };
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-extrabold text-blue-700">Admin Dashboard</h1>
          <button onClick={handleLogout} className="text-blue-700 hover:underline font-semibold">Logout</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-1 gap-8">
          <Link to="/admin/docs" className="bg-white/90 rounded-2xl shadow-xl p-8 hover:shadow-2xl hover:-translate-y-1 transition">
            <div className="flex items-center mb-2">
              <FileIcon className="h-7 w-7 text-blue-500 mr-3" />
              <h2 className="text-xl font-bold text-blue-700">Manage Documents</h2>
            </div>
            <p className="mt-2 text-gray-600">Upload and organize documents</p>
          </Link>
        </div>
      </div>
    </div>
  );
};

//---------------------- Admin Documents Page (Supabase) ----------------------//
const AdminDocumentsPage = () => {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [folderStack, setFolderStack] = useState<string[]>([]);
  const [showModal, setShowModal] = useState<null | "file" | "folder" | "edit">(null);
  const [modalTarget, setModalTarget] = useState<TreeNode | null>(null);
  const [modalInput, setModalInput] = useState<string>("");
  const [modalFile, setModalFile] = useState<FileList | null>(null);
  const [search, setSearch] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewDoc, setViewDoc] = useState<TreeNode | null>(null);
  const [uploading, setUploading] = useState(false);
  const [clipboard, setClipboard] = useState<{ type: "copy" | "cut", nodes: TreeNode[] } | null>(null);
  const [sort, setSort] = useState(getInitialSort());
  const [sortDropdownOpen, setSortDropdownOpen] = useState(false);
  const dragItem = useRef<TreeNode | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const [sortBy, sortOrder] = sort.split("-") as ["name" | "date" | "size", "asc" | "desc"];

  useEffect(() => {
    localStorage.setItem("adminDocsSort", sort);
  }, [sort]);

  const refresh = useCallback(async () => {
    const docs = await listTree();
    setTree(buildTree(docs));
    setSelected(new Set());
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!showModal && mainRef.current) {
      mainRef.current.focus();
    }
  }, [showModal, folderStack]);

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete ${selected.size} items?`)) return;
    setUploading(true);
    for (const id of Array.from(selected)) {
      const doc = findNodeById(id, tree);
      if (doc) await deleteFileOrFolder(doc.path, doc.type === "folder");
    }
    setUploading(false);
    setSelected(new Set());
    await refresh();
  };
  const handleBulkCopy = () => {
    const nodes = Array.from(selected).map(id => findNodeById(id, tree)).filter(Boolean) as TreeNode[];
    setClipboard({ type: "copy", nodes });
  };
  const handleBulkCut = () => {
    const nodes = Array.from(selected).map(id => findNodeById(id, tree)).filter(Boolean) as TreeNode[];
    setClipboard({ type: "cut", nodes });
  };

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (showModal) return;
    if ((e.ctrlKey || e.metaKey) && selected.size > 0) {
      if (e.key.toLowerCase() === "c") {
        handleBulkCopy();
      }
      if (e.key.toLowerCase() === "x") {
        handleBulkCut();
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && clipboard) {
      await doPaste();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const nodes = getCurrentChildren();
      setSelected(new Set(nodes.map((n) => n.id)));
    }
    if (e.key === "Delete" && selected.size > 0) {
      await handleBulkDelete();
    }
    if (e.key === "F2" && selected.size === 1) {
      const doc = findNodeById(Array.from(selected)[0], tree);
      if (doc) handleRename(doc);
    }
  };

  function findNodeById(id: string, nodes: TreeNode[]): TreeNode | null {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) {
        const found = findNodeById(id, n.children);
        if (found) return found;
      }
    }
    return null;
  }

  async function doPaste() {
    if (!clipboard) return;
    setUploading(true);
    for (let node of clipboard.nodes) {
      const destPath = (getCurrentPrefix() ? getCurrentPrefix() + "/" : "") + node.name;
      if (clipboard.type === "copy") {
        await copyFileOrFolder(node, destPath);
      }
      if (clipboard.type === "cut") {
        await moveFileOrFolder(node.path, destPath, node.type === "folder");
      }
    }
    if (clipboard.type === "cut") setClipboard(null);
    setUploading(false);
    await refresh();
  }

  async function copyFileOrFolder(node: TreeNode, destPath: string) {
    if (node.type === "folder") {
      const { data } = await supabase.storage.from(BUCKET).list(node.path, { limit: 1000 });
      for (const item of data || []) {
        const childPath = `${node.path}/${item.name}`;
        const childDestPath = `${destPath}/${item.name}`;
        if (item.metadata && item.metadata.mimetype) {
          const { data: fileData } = await supabase.storage.from(BUCKET).download(childPath);
          if (fileData) await supabase.storage.from(BUCKET).upload(childDestPath, fileData, { upsert: false });
        } else {
          await copyFileOrFolder({ ...node, path: childPath, name: item.name, type: "folder" }, childDestPath);
        }
      }
    } else {
      const { data } = await supabase.storage.from(BUCKET).download(node.path);
      if (data) await supabase.storage.from(BUCKET).upload(destPath, data, { upsert: false });
    }
  }

  function handleDragStart(doc: TreeNode) {
    dragItem.current = doc;
  }
  async function handleCardDrop(targetDoc: TreeNode | null) {
    if (!dragItem.current) return;
    let destPrefix = getCurrentPrefix();
    if (targetDoc && targetDoc.type === "folder") {
      destPrefix = targetDoc.id;
    } else if (targetDoc && targetDoc.type === "file") {
      const parentPath = targetDoc.path.substring(0, targetDoc.path.lastIndexOf("/"));
      if (parentPath) destPrefix = parentPath;
    }
    const destPath = destPrefix ? `${destPrefix}/${dragItem.current.name}` : dragItem.current.name;
    if (dragItem.current.path === destPath) {
      dragItem.current = null;
      return;
    }
    if (dragItem.current.type === "folder" && destPath.startsWith(dragItem.current.path)) {
      dragItem.current = null;
      return;
    }
    setUploading(true);
    await moveFileOrFolder(dragItem.current.path, destPath, dragItem.current.type === "folder");
    setUploading(false);
    dragItem.current = null;
    await refresh();
  }

  const getCurrentPrefix = () => folderStack.length ? folderStack[folderStack.length - 1] : "";

  function sortDocs(nodes: TreeNode[]): TreeNode[] {
    const sorted = [...nodes].sort((a, b) => {
      if (a.type === 'folder' && b.type !== 'folder') return -1;
      if (a.type !== 'folder' && b.type === 'folder') return 1;
      let comp = 0;
      if (sortBy === 'name') {
        comp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } else if (sortBy === 'size') {
        comp = (a.size || 0) - (b.size || 0);
      } else if (sortBy === 'date') {
        comp = (new Date(a.lastModified || 0).getTime()) - (new Date(b.lastModified || 0).getTime());
      }
      if (sortOrder === 'desc') comp = -comp;
      return comp;
    });
    return sorted.map(n => n.type === 'folder' && n.children
      ? { ...n, children: sortDocs(n.children) }
      : n
    );
  }

  function searchDocs(nodes: TreeNode[], q: string): TreeNode[] {
    if (!q.trim()) return nodes;
    q = q.toLowerCase();
    const filterTree = (docs: TreeNode[]): TreeNode[] =>
      docs
        .map(doc => {
          if (doc.type === "folder" && doc.children) {
            const children = filterTree(doc.children);
            if (children.length > 0 || doc.name.toLowerCase().includes(q)) {
              return { ...doc, children };
            }
            return null;
          } else if (doc.name.toLowerCase().includes(q)) {
            return doc;
          }
          return null;
        })
        .filter(Boolean) as TreeNode[];
    return filterTree(nodes);
  }

  function getCurrentChildren() {
    let node = tree;
    for (const id of folderStack) {
      const next = node.find(d => d.id === id && d.type === "folder");
      if (next && next.children) node = next.children;
      else return [];
    }
    return node;
  }
  const docsToShow = sortDocs(searchDocs(getCurrentChildren(), search));

  const renderSortDropdown = () => (
    <div className="relative">
      <button
        className="flex items-center border px-3 py-2 rounded-lg bg-white shadow hover:bg-blue-100"
        onClick={() => setSortDropdownOpen(o => !o)}
        type="button"
      >
        Sort
        <ChevronRight className={`ml-1 h-4 w-4 transition-transform ${sortDropdownOpen ? "rotate-90" : ""}`} />
      </button>
      {sortDropdownOpen && (
        <div
          className="absolute right-0 mt-2 w-56 bg-white border rounded-xl shadow-lg z-20"
          onMouseLeave={() => setSortDropdownOpen(false)}
        >
          <ul className="py-2">
            {SORT_OPTIONS.map(opt => (
              <li key={opt.value}>
                <label className="flex items-center px-4 py-2 cursor-pointer hover:bg-blue-50">
                  <input
                    type="radio"
                    name="sort"
                    value={opt.value}
                    checked={sort === opt.value}
                    onChange={() => {
                      setSort(opt.value);
                      setSortDropdownOpen(false);
                    }}
                    className="mr-2"
                  />
                  {opt.label}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  // Breadcrumbs (no horizontal scroll, wraps, truncates long names)
  let crumbs: { name: string, id: string, path: string[] }[] = [{ name: "Root", id: "root", path: [] }];
  let node = tree;
  let pathArr: string[] = [];
  for (const id of folderStack) {
    const found = node.find(d => d.id === id && d.type === "folder");
    if (found) {
      pathArr = [...pathArr, id];
      crumbs.push({ name: found.name, id: found.id, path: [...pathArr] });
      node = found.children || [];
    }
  }
  const renderBreadcrumbs = () => (
    <nav className="flex flex-wrap items-center mb-4 gap-y-1 overflow-x-hidden w-full">
      {crumbs.map((c, i) => (
        <span key={c.id} className="flex items-center min-w-0">
          <button
            onClick={() => setFolderStack(c.path)}
            className="text-blue-600 hover:underline font-bold truncate"
            style={{ maxWidth: 120 }}
          >
            {c.name}
          </button>
          {i < crumbs.length - 1 && <ChevronRight className="h-4 w-4 mx-1 text-gray-300" />}
        </span>
      ))}
    </nav>
  );

  // Tree: only checkbox toggles selection, click elsewhere navigates/view
  const renderTree = (nodes: TreeNode[]) => {
    const folders = nodes.filter(doc => doc.type === "folder");
    const files = nodes.filter(doc => doc.type === "file");
    const all = [...folders, ...files];

    return (
      <ul className="divide-y divide-gray-200 mt-2">
        {all.map(doc => {
          const isChecked = selected.has(doc.id);
          return (
            <li
              key={doc.id}
              className={`flex items-center gap-2 py-2 px-2 group cursor-pointer transition-all w-full min-w-0
                ${isChecked ? "bg-blue-50" : ""}`}
              onClick={e => {
                if ((e.target as HTMLElement).closest("input[type=checkbox],button")) return;
                if (doc.type === "folder") setFolderStack([...folderStack, doc.id]);
              }}
              onDoubleClick={e => {
                if (doc.type === "file") setViewDoc(doc);
              }}
              draggable
              onDragStart={() => handleDragStart(doc)}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); handleCardDrop(doc); }}
              tabIndex={0}
              role="button"
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                  if (doc.type === "folder") setFolderStack([...folderStack, doc.id]);
                  else setViewDoc(doc);
                }
              }}
            >
              <input
                type="checkbox"
                checked={isChecked}
                onChange={e => {
                  setSelected(sel => {
                    const set = new Set(sel);
                    if (e.target.checked) set.add(doc.id);
                    else set.delete(doc.id);
                    return set;
                  });
                }}
                onClick={e => e.stopPropagation()}
                className="mr-1 flex-shrink-0"
              />
              {doc.type === "folder" ? (
                <FolderIcon className="h-6 w-6 text-yellow-500 flex-shrink-0" />
              ) : (
                <FileIcon className="h-6 w-6 text-blue-500 flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-y-1">
                <span className="font-medium text-xs break-words whitespace-normal min-w-0">
                  {doc.type === "folder" ? doc.name : getBaseName(doc.name)}
                </span>
                <div className="flex flex-row flex-wrap gap-x-2 gap-y-1 sm:ml-4">
                  {doc.size && doc.type === "file" && (
                    <span className="text-xs text-gray-600 whitespace-nowrap">{formatFileSize(doc.size)}</span>
                  )}
                  {doc.lastModified && (
                    <span className="text-xs text-gray-400 whitespace-nowrap">{new Date(doc.lastModified).toLocaleString()}</span>
                  )}
                </div>
              </div>
              <div className="flex gap-1 flex-shrink-0 ml-2">
                {doc.type === "folder" ? (
                  <>
                    <button
                      onClick={e => { e.stopPropagation(); handleRename(doc); }}
                      className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                      tabIndex={-1}
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(doc); }}
                      className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-100"
                      tabIndex={-1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); setFolderStack([...folderStack, doc.id]); }}
                      className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                      tabIndex={-1}
                      title="Open"
                    >
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={e => { e.stopPropagation(); setViewDoc(doc); }}
                      className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                      tabIndex={-1}
                    >
                      View
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); handleRename(doc); }}
                      className="text-blue-600 hover:text-blue-800 p-1 rounded hover:bg-blue-100"
                      tabIndex={-1}
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(doc); }}
                      className="text-red-600 hover:text-red-800 p-1 rounded hover:bg-red-100"
                      tabIndex={-1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
        {all.length === 0 && (
          <li className="text-gray-400 px-2 py-4">Empty folder</li>
        )}
      </ul>
    );
  };

  const renderDocViewer = (doc: TreeNode) => {
    const url = supabase.storage.from(BUCKET).getPublicUrl(doc.path).data.publicUrl;
    const ext = doc.name.split('.').pop()?.toLowerCase() || "";
    if (["png", "jpg", "jpeg", "gif", "bmp", "webp"].includes(ext)) {
      return <img src={url} alt={doc.name} className="max-h-[70vh] max-w-full mx-auto rounded shadow" />;
    }
    if (ext === "pdf") {
      return <iframe title={doc.name} src={url} className="w-full" style={{ minHeight: "70vh" }} />;
    }
    if (["txt", "md", "csv", "json", "log"].includes(ext)) {
      return <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600">View Raw Text</a>;
    }
    return (
      <div>
        <p>Cannot preview this file type.</p>
        <a href={url} download={doc.name} className="text-blue-600 underline">Download</a>
      </div>
    );
  };

  const handleAdd = (type: "file" | "folder") => {
    setShowModal(type);
    setModalInput("");
    setModalFile(null);
  };
  const handleRename = (doc: TreeNode) => {
    setModalTarget(doc);
    setModalInput(doc.name);
    setShowModal("edit");
  };
  const doAdd = async () => {
    setUploading(true);
    if (showModal === "folder" && modalInput.trim()) {
      const folderPath = (getCurrentPrefix() ? getCurrentPrefix() + "/" : "") + sanitizeName(modalInput);
      if (await fileOrFolderExists(folderPath)) {
        if (!window.confirm(`Folder "${modalInput}" already exists. Do you want to replace it?`)) {
          setUploading(false);
          setShowModal(null);
          setModalInput("");
          return;
        }
        await deleteFileOrFolder(folderPath, true);
      }
      await uploadFile(folderPath + "/.keep", new Blob([""], { type: "text/plain" }) as any as File);
      setShowModal(null);
      setModalInput("");
      await refresh();
    }
    if (showModal === "file" && modalFile) {
      for (const file of Array.from(modalFile)) {
        const path = (getCurrentPrefix() ? getCurrentPrefix() + "/" : "") + sanitizeName(file.name);
        if (await fileOrFolderExists(path)) {
          if (!window.confirm(`File "${file.name}" already exists. Do you want to replace it?`)) {
            continue;
          }
          await deleteFileOrFolder(path, false);
        }
        await uploadFile(path, file);
      }
      setShowModal(null);
      setModalFile(null);
      setModalInput("");
      await refresh();
    }
    setUploading(false);
  };

  const doRename = async () => {
    if (!modalTarget) return;
    const newName = modalInput.trim();
    if (!newName || newName === modalTarget.name) { setShowModal(null); return; }
    const prefix = modalTarget.path.substring(0, modalTarget.path.lastIndexOf("/"));
    const newPath = (prefix ? prefix + "/" : "") + newName + (modalTarget.type === "folder" ? "" : "");
    await moveFileOrFolder(modalTarget.path, newPath, modalTarget.type === "folder");
    setShowModal(null);
    setModalTarget(null);
    await refresh();
  };
  const handleDelete = async (doc: TreeNode) => {
    if (!window.confirm(`Delete ${doc.name}?`)) return;
    setUploading(true);
    await deleteFileOrFolder(doc.path, doc.type === "folder");
    setUploading(false);
    await refresh();
  };
  const handleFolderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    setUploading(true);
    await uploadFilesWithFolders(getCurrentPrefix(), e.target.files);
    setUploading(false);
    await refresh();
  };

  const handleGlobalDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setUploading(true);

    let allFiles: File[] = [];

    const traverseFileTree = async (item: any, path = ""): Promise<File[]> => {
      return new Promise<File[]>((resolve) => {
        if (item.isFile) {
          item.file((file: File) => {
            Object.defineProperty(file, 'webkitRelativePath', {
              value: path + file.name,
              writable: false
            });
            resolve([file]);
          });
        } else if (item.isDirectory) {
          const dirReader = item.createReader();
          dirReader.readEntries(async (entries: any) => {
            const files = (await Promise.all(entries.map((entry: any) => traverseFileTree(entry, path + item.name + "/")))).flat();
            resolve(files);
          });
        } else {
          resolve([]);
        }
      });
    };

    if (e.dataTransfer.items && e.dataTransfer.items.length > 0 && 'webkitGetAsEntry' in e.dataTransfer.items[0]) {
      const entries: any[] = [];
      for (let i = 0; i < e.dataTransfer.items.length; i++) {
        const entry = e.dataTransfer.items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      const all = await Promise.all(entries.map(entry => traverseFileTree(entry, "")));
      allFiles = all.flat();
    } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      allFiles = Array.from(e.dataTransfer.files);
    }

    if (allFiles.length > 0) {
      await uploadFilesWithFolders(getCurrentPrefix(), allFiles);
    }

    setUploading(false);
    await refresh();
  };
  const handleGlobalDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // --- Main Render ---
  return (
    <div
      className="min-h-screen bg-gradient-to-br from-blue-50 to-slate-100 p-4 overflow-y-auto overflow-x-hidden w-full"
      tabIndex={0}
      ref={mainRef}
      onKeyDown={handleKeyDown}
      onDrop={handleGlobalDrop}
      onDragOver={handleGlobalDragOver}
    >
      <div className="max-w-6xl w-full mx-auto">
        <button
          className="inline-flex items-center text-blue-600 mb-4 hover:underline"
          onClick={() => window.history.back()}
        >
          <ArrowLeft className="mr-1 h-5 w-5" /> Back to Dashboard
        </button>
        <div className="bg-white/90 rounded-2xl shadow-2xl p-8 w-full">
          <h2 className="text-2xl font-bold mb-4 flex items-center text-blue-700">
            <FolderIcon className="mr-2 h-6 w-6" /> Manage Documents
          </h2>
          {renderBreadcrumbs()}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <button
              className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded disabled:opacity-50"
              disabled={selected.size === 0}
              onClick={handleBulkDelete}
            >Delete</button>
            <button
              className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded disabled:opacity-50"
              disabled={selected.size === 0}
              onClick={handleBulkCut}
            >Cut</button>
            <button
              className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded disabled:opacity-50"
              disabled={selected.size === 0}
              onClick={handleBulkCopy}
            >Copy</button>
            <button
              className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded disabled:opacity-50"
              disabled={!clipboard}
              onClick={doPaste}
            >Paste</button>
            <span className="ml-2 text-gray-500 text-sm">
              {selected.size > 0 && `${selected.size} selected`}
            </span>
          </div>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search documents in this folder..."
              className="border rounded px-3 py-2 w-full md:w-1/3"
            />
            {renderSortDropdown()}
            {uploading && <span className="ml-3 text-blue-600 animate-pulse">Uploading...</span>}
          </div>
          <div className="mb-6 flex flex-wrap gap-3">
            <button className="bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-lg flex items-center gap-1 font-semibold shadow transition" onClick={() => handleAdd("folder")}><Plus className="h-4 w-4" />New Folder</button>
            <button className="bg-green-600 hover:bg-green-700 text-white py-2 px-4 rounded-lg flex items-center gap-1 font-semibold shadow transition" onClick={() => handleAdd("file")}><Plus className="h-4 w-4" />Upload File</button>
            <label className="bg-purple-600 hover:bg-purple-700 text-white py-2 px-4 rounded-lg flex items-center gap-1 font-semibold shadow transition cursor-pointer">
              <Upload className="h-4 w-4" /> Upload Folder
              <input
                type="file"
                style={{ display: "none" }}
                multiple
                // @ts-ignore
                webkitdirectory=""
                onChange={handleFolderUpload}
              />
            </label>
            {folderStack.length > 0 && (
              <button className="bg-gray-200 px-3 py-2 rounded-lg flex items-center gap-1 font-semibold shadow hover:bg-gray-300 transition" onClick={() => setFolderStack(folderStack.slice(0, -1))}><ArrowLeft className="h-4 w-4" />Back</button>
            )}
          </div>
          <div className="border rounded-xl p-4 bg-gray-50/60 w-full overflow-x-hidden">
            {docsToShow.length ? renderTree(docsToShow) : <p className="text-gray-400">Empty folder</p>}
          </div>
        </div>
      </div>
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md animate-fadein">
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-bold text-xl">{showModal === "edit" ? "Rename" : showModal === "file" ? "Upload File(s)" : "New Folder"}</h3>
              <button onClick={() => setShowModal(null)}><X className="h-5 w-5" /></button>
            </div>
            {showModal === "file" ? (
              <input type="file" multiple onChange={e => setModalFile(e.target.files)} className="mb-4" />
            ) : (
              <input type="text" className="w-full border-2 rounded-lg p-2 mb-4" value={modalInput} onChange={e => setModalInput(e.target.value)} placeholder="Name" />
            )}
            <div className="flex justify-end">
              <button onClick={showModal === "edit" ? doRename : doAdd} className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg font-semibold shadow transition">{showModal === "edit" ? "Rename" : "Add"}</button>
            </div>
          </div>
        </div>
      )}
      {viewDoc && (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
          <div className="flex items-center p-4 bg-blue-700 shadow">
            <button
              className="mr-4 text-white flex items-center gap-2 font-bold text-lg"
              onClick={() => setViewDoc(null)}
            >
              <ArrowLeft className="h-6 w-6" /> Back
            </button>
            <span className="text-white font-semibold truncate">{getBaseName(viewDoc.name)}</span>
          </div>
          <div className="flex-1 p-0 overflow-auto flex justify-center items-center bg-black bg-opacity-5">
            <div className="w-full h-full flex items-center justify-center">
              {renderDocViewer(viewDoc)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

//---------------------- Protected Route ----------------------//
type ProtectedRouteProps = {
  children: React.ReactNode;
};
const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const isAuthenticated = localStorage.getItem('isAuthenticated') === 'true';
  if (!isAuthenticated) {
    return <Navigate to="/admin/login" replace />;
  }
  return <>{children}</>;
};

//---------------------- Main App ----------------------//
const App = () => (
  <Router>
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/documents/login" element={<PublicDocsLogin />} />
      <Route
        path="/documents"
        element={
          <PublicProtectedRoute>
            <DocumentsPage />
          </PublicProtectedRoute>
        }
      />
       <Route path="/track" element={<TrackPage />} /> 
      <Route path="/contact" element={<ContactUsPage />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<ProtectedRoute><AdminDashboard /></ProtectedRoute>} />
      <Route path="/admin/docs" element={<ProtectedRoute><AdminDocumentsPage /></ProtectedRoute>} />
    </Routes>
  </Router>
);

export default App;

// A small but representative `project.pbxproj`, in the format Xcode writes.
//
// It covers the shapes the importer has to handle: an app target, a framework
// target with a nested group path, a shared file compiled by both, a local
// Swift package added as a folder reference, a localised resource, an asset
// catalog, a test target and the usual configuration lists.

export const FIXTURE_PBX = String.raw`// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {

/* Begin PBXBuildFile section */
		1A0000000000000000000001 /* AppMain.swift in Sources */ = {isa = PBXBuildFile; fileRef = 2B0000000000000000000001 /* AppMain.swift */; };
		1A0000000000000000000002 /* ContentView.swift in Sources */ = {isa = PBXBuildFile; fileRef = 2B0000000000000000000002 /* ContentView.swift */; };
		1A0000000000000000000003 /* Shared.swift in Sources */ = {isa = PBXBuildFile; fileRef = 2B0000000000000000000003 /* Shared.swift */; };
		1A0000000000000000000004 /* Shared.swift in Sources */ = {isa = PBXBuildFile; fileRef = 2B0000000000000000000003 /* Shared.swift */; };
		1A0000000000000000000005 /* Kit.swift in Sources */ = {isa = PBXBuildFile; fileRef = 2B0000000000000000000004 /* Kit.swift */; };
		1A0000000000000000000006 /* en in Resources */ = {isa = PBXBuildFile; fileRef = 2B000000000000000000000A /* en */; };
		1A0000000000000000000007 /* Assets.xcassets in Resources */ = {isa = PBXBuildFile; fileRef = 2B0000000000000000000005 /* Assets.xcassets */; };
		1A0000000000000000000008 /* LocalKit in Frameworks */ = {isa = PBXBuildFile; productRef = 3C0000000000000000000001 /* LocalKit */; };
		1A0000000000000000000009 /* AppMain.swift in Sources */ = {isa = PBXBuildFile; fileRef = 2B0000000000000000000001 /* AppMain.swift */; };
/* End PBXBuildFile section */

/* Begin PBXContainerItemProxy section */
		4D0000000000000000000001 /* PBXContainerItemProxy */ = {
			isa = PBXContainerItemProxy;
			containerPortal = 5E0000000000000000000001 /* Project object */;
			proxyType = 1;
			remoteGlobalIDString = 6F0000000000000000000002;
			remoteInfo = MyKit;
		};
/* End PBXContainerItemProxy section */

/* Begin PBXFileReference section */
		2B0000000000000000000001 /* AppMain.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppMain.swift; sourceTree = "<group>"; };
		2B0000000000000000000002 /* ContentView.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ContentView.swift; sourceTree = "<group>"; };
		2B0000000000000000000003 /* Shared.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = Shared.swift; sourceTree = "<group>"; };
		2B0000000000000000000004 /* Kit.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = Kit.swift; sourceTree = "<group>"; };
		2B0000000000000000000005 /* Assets.xcassets */ = {isa = PBXFileReference; lastKnownFileType = folder.assetcatalog; path = Assets.xcassets; sourceTree = "<group>"; };
		2B0000000000000000000006 /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };
		2B0000000000000000000007 /* LocalKit */ = {isa = PBXFileReference; lastKnownFileType = wrapper; path = LocalKit; sourceTree = "<group>"; };
		2B0000000000000000000008 /* My App.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = "My App.app"; sourceTree = BUILT_PRODUCTS_DIR; };
		2B0000000000000000000009 /* MyAppTests.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = MyAppTests.swift; sourceTree = "<group>"; };
		2B000000000000000000000A /* en */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = en; path = en.lproj/Localizable.strings; sourceTree = "<group>"; };
		2B000000000000000000000B /* Notes.bin */ = {isa = PBXFileReference; lastKnownFileType = archive.macbinary; path = Notes.bin; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXFrameworksBuildPhase section */
		7A0000000000000000000001 /* Frameworks */ = {
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
				1A0000000000000000000008 /* LocalKit in Frameworks */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXFrameworksBuildPhase section */

/* Begin PBXGroup section */
		8B0000000000000000000001 = {
			isa = PBXGroup;
			children = (
				8B0000000000000000000002 /* App */,
				8B0000000000000000000003 /* Framework */,
				2B0000000000000000000007 /* LocalKit */,
				8B0000000000000000000004 /* Products */,
				8B0000000000000000000005 /* Tests */,
			);
			sourceTree = "<group>";
		};
		8B0000000000000000000002 /* App */ = {
			isa = PBXGroup;
			children = (
				2B0000000000000000000001 /* AppMain.swift */,
				2B0000000000000000000002 /* ContentView.swift */,
				2B0000000000000000000003 /* Shared.swift */,
				2B0000000000000000000005 /* Assets.xcassets */,
				9C0000000000000000000001 /* Localizable.strings */,
				2B0000000000000000000006 /* Info.plist */,
				2B000000000000000000000B /* Notes.bin */,
			);
			path = App;
			sourceTree = "<group>";
		};
		8B0000000000000000000003 /* Framework */ = {
			isa = PBXGroup;
			children = (
				2B0000000000000000000004 /* Kit.swift */,
			);
			path = Framework/Sources;
			sourceTree = "<group>";
		};
		8B0000000000000000000004 /* Products */ = {
			isa = PBXGroup;
			children = (
				2B0000000000000000000008 /* My App.app */,
			);
			name = Products;
			sourceTree = "<group>";
		};
		8B0000000000000000000005 /* Tests */ = {
			isa = PBXGroup;
			children = (
				2B0000000000000000000009 /* MyAppTests.swift */,
			);
			path = Tests;
			sourceTree = "<group>";
		};
/* End PBXGroup section */

/* Begin PBXNativeTarget section */
		6F0000000000000000000001 /* My App */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = 0D0000000000000000000002 /* Build configuration list for PBXNativeTarget "My App" */;
			buildPhases = (
				AB0000000000000000000001 /* Sources */,
				7A0000000000000000000001 /* Frameworks */,
				AC0000000000000000000001 /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
				AD0000000000000000000001 /* PBXTargetDependency */,
			);
			name = "My App";
			packageProductDependencies = (
				3C0000000000000000000001 /* LocalKit */,
			);
			productName = "My App";
			productReference = 2B0000000000000000000008 /* My App.app */;
			productType = "com.apple.product-type.application";
		};
		6F0000000000000000000002 /* MyKit */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = 0D0000000000000000000003 /* Build configuration list for PBXNativeTarget "MyKit" */;
			buildPhases = (
				AB0000000000000000000002 /* Sources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = MyKit;
			productName = MyKit;
			productReference = 2B000000000000000000000C /* MyKit.framework */;
			productType = "com.apple.product-type.framework";
		};
		6F0000000000000000000003 /* MyAppTests */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = 0D0000000000000000000004 /* Build configuration list for PBXNativeTarget "MyAppTests" */;
			buildPhases = (
				AB0000000000000000000003 /* Sources */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = MyAppTests;
			productName = MyAppTests;
			productReference = 2B000000000000000000000D /* MyAppTests.xctest */;
			productType = "com.apple.product-type.bundle.unit-test";
		};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		5E0000000000000000000001 /* Project object */ = {
			isa = PBXProject;
			attributes = {
				LastUpgradeCheck = 1500;
				TargetAttributes = {
					6F0000000000000000000001 = {
						CreatedOnToolsVersion = 15.0;
					};
				};
			};
			buildConfigurationList = 0D0000000000000000000001 /* Build configuration list for PBXProject "MyApp" */;
			compatibilityVersion = "Xcode 14.0";
			developmentRegion = en;
			hasScannedForEncodings = 0;
			knownRegions = (
				en,
				Base,
			);
			mainGroup = 8B0000000000000000000001;
			productRefGroup = 8B0000000000000000000004 /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
				6F0000000000000000000001 /* My App */,
				6F0000000000000000000002 /* MyKit */,
				6F0000000000000000000003 /* MyAppTests */,
			);
		};
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
		AC0000000000000000000001 /* Resources */ = {
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				1A0000000000000000000007 /* Assets.xcassets in Resources */,
				1A0000000000000000000006 /* en in Resources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXResourcesBuildPhase section */

/* Begin PBXSourcesBuildPhase section */
		AB0000000000000000000001 /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				1A0000000000000000000001 /* AppMain.swift in Sources */,
				1A0000000000000000000002 /* ContentView.swift in Sources */,
				1A0000000000000000000003 /* Shared.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
		AB0000000000000000000002 /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				1A0000000000000000000005 /* Kit.swift in Sources */,
				1A0000000000000000000004 /* Shared.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
		AB0000000000000000000003 /* Sources */ = {
			isa = PBXSourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				1A0000000000000000000009 /* AppMain.swift in Sources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXSourcesBuildPhase section */

/* Begin PBXTargetDependency section */
		AD0000000000000000000001 /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = 6F0000000000000000000002 /* MyKit */;
			targetProxy = 4D0000000000000000000001 /* PBXContainerItemProxy */;
		};
/* End PBXTargetDependency section */

/* Begin PBXVariantGroup section */
		9C0000000000000000000001 /* Localizable.strings */ = {
			isa = PBXVariantGroup;
			children = (
				2B000000000000000000000A /* en */,
			);
			name = Localizable.strings;
			sourceTree = "<group>";
		};
/* End PBXVariantGroup section */

/* Begin XCSwiftPackageProductDependency section */
		3C0000000000000000000001 /* LocalKit */ = {
			isa = XCSwiftPackageProductDependency;
			productName = LocalKit;
		};
/* End XCSwiftPackageProductDependency section */

/* Begin XCBuildConfiguration section */
		0E0000000000000000000001 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				SWIFT_VERSION = 5.0;
			};
			name = Debug;
		};
		0E0000000000000000000002 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				SWIFT_VERSION = 5.0;
			};
			name = Release;
		};
		0E0000000000000000000003 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				INFOPLIST_FILE = "App/Info.plist";
				MARKETING_VERSION = 2.1;
				CURRENT_PROJECT_VERSION = 42;
				PRODUCT_BUNDLE_IDENTIFIER = com.example.myapp;
				PRODUCT_NAME = "$(TARGET_NAME)";
			};
			name = Debug;
		};
		0E0000000000000000000004 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				INFOPLIST_FILE = "App/Info.plist";
				MARKETING_VERSION = 2.1;
				CURRENT_PROJECT_VERSION = 42;
				PRODUCT_BUNDLE_IDENTIFIER = com.example.myapp;
				PRODUCT_NAME = "$(TARGET_NAME)";
			};
			name = Release;
		};
		0E0000000000000000000005 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = "com.example.myapp.MyKit";
				PRODUCT_NAME = "$(TARGET_NAME:c99extidentifier)";
			};
			name = Release;
		};
		0E0000000000000000000006 /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = "com.example.myapp.MyAppTests";
			};
			name = Release;
		};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		0D0000000000000000000001 /* Build configuration list for PBXProject "MyApp" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				0E0000000000000000000001 /* Debug */,
				0E0000000000000000000002 /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		0D0000000000000000000002 /* Build configuration list for PBXNativeTarget "My App" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				0E0000000000000000000003 /* Debug */,
				0E0000000000000000000004 /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		0D0000000000000000000003 /* Build configuration list for PBXNativeTarget "MyKit" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				0E0000000000000000000005 /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		0D0000000000000000000004 /* Build configuration list for PBXNativeTarget "MyAppTests" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				0E0000000000000000000006 /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
/* End XCConfigurationList section */
	};
	rootObject = 5E0000000000000000000001 /* Project object */;
}
`;

/** An Xcode style Info.plist with variables, used by the conversion test. */
export const FIXTURE_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
	<key>CFBundleVersion</key>
	<string>$(CURRENT_PROJECT_VERSION)</string>
	<key>UILaunchScreen</key>
	<dict/>
</dict>
</plist>
`;

/** A filesystem listing that matches `FIXTURE_PBX`. */
export function fixtureDirectory(absolutePath: string): string[] {
  const entries: Record<string, string[]> = {
    "/work/MyApp.xcodeproj": [],
    "/work/App/en.lproj": ["/work/App/en.lproj/Localizable.strings"],
    "/work/Framework/Sources": ["/work/Framework/Sources/Kit.swift"],
    "/work/LocalKit": ["/work/LocalKit/Package.swift", "/work/LocalKit/Sources"],
    "/work/Tests": ["/work/Tests/MyAppTests.swift"],
  };
  return entries[absolutePath] ?? [];
}

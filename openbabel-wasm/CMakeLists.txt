cmake_minimum_required(VERSION 3.19)
project(AvogadroOpenBabel LANGUAGES C CXX)

# This project deliberately builds independently of Qt and Avogadro's WASM SDK.
set(OPENBABEL_SOURCE_DIR "" CACHE PATH "Open Babel source checkout")
if(NOT EXISTS "${OPENBABEL_SOURCE_DIR}/src/charges/gasteiger.cpp")
  message(FATAL_ERROR "Set OPENBABEL_SOURCE_DIR to an Open Babel 3 source checkout")
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
add_compile_options(-ffunction-sections -fdata-sections)
if(EMSCRIPTEN)
  add_compile_options(-fexceptions)
  # The upstream CLI target probes pthread even when excluded from this build.
  set(PTHREAD_LIBRARY "" CACHE STRING "Unused CLI pthread library" FORCE)
endif()
set(BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ENABLE_TESTS OFF CACHE BOOL "" FORCE)
set(MINIMAL_BUILD ON CACHE BOOL "" FORCE)
set(BUILD_GUI OFF CACHE BOOL "" FORCE)
set(WITH_INCHI OFF CACHE BOOL "" FORCE)
set(WITH_MAEPARSER OFF CACHE BOOL "" FORCE)
set(WITH_COORDGEN OFF CACHE BOOL "" FORCE)
if(NOT EMSCRIPTEN AND UNIX)
  # Open Babel's static build otherwise locates glibc's private libm archive.
  set(MATH_LIBRARY m CACHE STRING "System math library" FORCE)
endif()
# The builder, UFF, SMILES and MOL work without these optional dependencies.
foreach(package LibXml2 ZLIB Eigen3 Eigen2 wxWidgets Boost)
  set(CMAKE_DISABLE_FIND_PACKAGE_${package} TRUE)
endforeach()
add_subdirectory("${OPENBABEL_SOURCE_DIR}" openbabel EXCLUDE_FROM_ALL)

# Compile the required plugin objects into the executable so static registration
# survives archive extraction. Unused plugins in the archive are discarded.
add_executable(openbabel-web openbabel-web.cpp
  "${OPENBABEL_SOURCE_DIR}/src/charges/gasteiger.cpp"
  "${OPENBABEL_SOURCE_DIR}/src/forcefields/forcefielduff.cpp"
  "${OPENBABEL_SOURCE_DIR}/src/formats/smilesformat.cpp"
  "${OPENBABEL_SOURCE_DIR}/src/formats/mdlformat.cpp")
target_include_directories(openbabel-web PRIVATE
  "${OPENBABEL_SOURCE_DIR}/include" "${OPENBABEL_SOURCE_DIR}/src"
  "${CMAKE_BINARY_DIR}/openbabel/include")
target_link_libraries(openbabel-web PRIVATE openbabel)
target_link_options(openbabel-web PRIVATE -Wl,--gc-sections)
if(EMSCRIPTEN)
  target_compile_definitions(openbabel-web PRIVATE OPENBABEL_DATA_DIR="/openbabel-data")
  foreach(asset UFF.prm rigid-fragments.txt rigid-fragments-index.txt ring-fragments.txt)
    target_link_options(openbabel-web PRIVATE
      "SHELL:--embed-file \"${OPENBABEL_SOURCE_DIR}/data/${asset}@/openbabel-data/${asset}\"")
    set_property(TARGET openbabel-web APPEND PROPERTY LINK_DEPENDS
      "${OPENBABEL_SOURCE_DIR}/data/${asset}")
  endforeach()
  set_target_properties(openbabel-web PROPERTIES SUFFIX ".js")
  # Open Babel probes data files before falling back to its compiled-in tables.
  # Keep Emscripten's virtual filesystem for those std::ifstream operations.
  target_link_options(openbabel-web PRIVATE --bind -fexceptions
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createOpenBabel
    -sENVIRONMENT=worker -sALLOW_MEMORY_GROWTH=1)
else()
  target_compile_definitions(openbabel-web PRIVATE OPENBABEL_DATA_DIR="${OPENBABEL_SOURCE_DIR}/data")
endif()
